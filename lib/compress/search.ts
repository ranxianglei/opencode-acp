import { tool } from "@opencode-ai/plugin"
import type { SessionState, WithParts } from "../state"
import { formatBlockRef, formatMessageRef, parseBoundaryId, parseMessageRef } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countAllMessageTokens } from "../token-utils"
import type { BoundaryReference, SearchContext, SelectionResolution, ToolContext } from "./types"

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
    }
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryLookup(context, state)
    const issues: string[] = []
    const parsedStartId = parseBoundaryId(startId)
    const parsedEndId = parseBoundaryId(endId)

    if (parsedStartId === null) {
        issues.push("startId is invalid. Use an injected message ID (mNNNNN) or block ID (bN).")
    }

    if (parsedEndId === null) {
        issues.push("endId is invalid. Use an injected message ID (mNNNNN) or block ID (bN).")
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!parsedStartId || !parsedEndId) {
        throw new Error("Invalid boundary ID(s)")
    }

    let startReference = lookup.get(parsedStartId.ref)
    let endReference = lookup.get(parsedEndId.ref)

    // [FIX] Fault tolerance: if an ID is beyond the last available message
    // (model guessed m00019 but only m00018 exists), clamp to the last visible
    // message instead of failing hard. Only applies to numeric message refs (mN),
    // not block refs (bN) — block refs must match exactly.
    if (!startReference && parsedStartId.kind === "message") {
        const clamped = clampMessageRef(parsedStartId, context, state)
        if (clamped) {
            startReference = lookup.get(clamped.ref)
            if (startReference) {
                parsedStartId.ref = clamped.ref
            }
        }
    }
    if (!endReference && parsedEndId.kind === "message") {
        const clamped = clampMessageRef(parsedEndId, context, state)
        if (clamped) {
            endReference = lookup.get(clamped.ref)
            if (endReference) {
                parsedEndId.ref = clamped.ref
            }
        }
    }

    if (!startReference) {
        issues.push(
            `startId ${parsedStartId.ref} is not available — likely consumed by an existing block.`,
        )
    }

    if (!endReference) {
        issues.push(
            `endId ${parsedEndId.ref} is not available — likely consumed by an existing block.`,
        )
    }

    if (issues.length > 0) {
        const hint = buildBoundaryRecoveryHint(context, state)
        const body =
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n")
        throw new Error(hint ? `${body}\n${hint}` : body)
    }

    if (!startReference || !endReference) {
        throw new Error("Failed to resolve boundary IDs")
    }

    // [FIX Bug 34] Auto-swap reversed boundaries instead of throwing.
    // Block IDs (bN) are assigned in creation order, which may not match
    // conversation order. Models naturally assume bN < bM means bN is earlier,
    // but anchor message ordering can differ. Auto-swap prevents compress failures
    // that cause models to give up without compressing.
    if (startReference.rawIndex > endReference.rawIndex) {
        ;[startReference, endReference] = [endReference, startReference]
    }

    return { startReference, endReference }
}

function buildBoundaryRecoveryHint(context: SearchContext, state: SessionState): string {
    const visibleRefs: string[] = []
    for (const [messageRef, messageId] of state.messageIds.byRef) {
        if (context.rawMessagesById.has(messageId)) {
            visibleRefs.push(messageRef)
        }
    }

    const parts: string[] = []
    if (visibleRefs.length > 0) {
        visibleRefs.sort()
        const first = visibleRefs[0]
        const last = visibleRefs[visibleRefs.length - 1]
        parts.push(`Current visible: ${first}–${last} (${visibleRefs.length} msgs).`)
    }

    const blockCount = context.summaryByBlockId.size
    if (blockCount > 0) {
        parts.push(`${blockCount} active compressed block${blockCount === 1 ? "" : "s"}.`)
    }

    if (parts.length === 0) {
        return ""
    }

    return `${parts.join(" ")} Call acp_status() to see which blocks consumed which IDs, then retry with valid IDs.`
}

function clampMessageRef(
    requested: { ref: string; index: number },
    context: SearchContext,
    state: SessionState,
): { ref: string } | null {
    if (state.messageIds.byRef.has(requested.ref)) return null
    let maxIndex = -1
    for (const [messageRef, messageId] of state.messageIds.byRef) {
        if (!context.rawMessagesById.has(messageId)) continue
        const idx = parseMessageRef(messageRef)
        if (idx !== null && idx > maxIndex) maxIndex = idx
    }
    if (maxIndex < 0 || requested.index <= maxIndex) return null
    return { ref: formatMessageRef(maxIndex) }
}

export function resolveSelection(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): SelectionResolution {
    const startRawIndex = startReference.rawIndex
    const endRawIndex = endReference.rawIndex
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, countAllMessageTokens(rawMessage))
        }

        const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    const selectedMessageIds = new Set(messageIds)
    const summariesInSelection: Array<{ blockId: number; rawIndex: number }> = []
    for (const summary of context.summaryByBlockId.values()) {
        if (!selectedMessageIds.has(summary.anchorMessageId)) {
            continue
        }

        const anchorIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }

        summariesInSelection.push({
            blockId: summary.blockId,
            rawIndex: anchorIndex,
        })
    }

    summariesInSelection.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    for (const summary of summariesInSelection) {
        if (requiredBlockSeen.has(summary.blockId)) {
            continue
        }
        requiredBlockSeen.add(summary.blockId)
        requiredBlockIds.push(summary.blockId)
    }

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    if (startReference.kind === "compressed-block") {
        if (!startReference.anchorMessageId) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        return startReference.anchorMessageId
    }

    if (!startReference.messageId) {
        throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.messageId
}

function buildBoundaryLookup(
    context: SearchContext,
    state: SessionState,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()

    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }
        if (isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }

    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (isIgnoredUserMessage(anchorMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId)
        if (!lookup.has(blockRef)) {
            lookup.set(blockRef, {
                kind: "compressed-block",
                rawIndex,
                blockId: summary.blockId,
                anchorMessageId: summary.anchorMessageId,
            })
        }
    }

    return lookup
}

const SEARCH_CONTEXT_TOOL_DESCRIPTION = `Search through all compressed block summaries AND visible messages to find relevant content. Use this BEFORE decompressing to find the right block. Returns a hit list with block/message IDs, relevance scores, and previews.

Examples:
- search_context({ query: "decoder accuracy" }) — find blocks/messages about decoder accuracy
- search_context({ query: "training loss PPL" }) — find training results
- search_context({ query: "architecture design", limit: 5 }) — top 5 results`

interface SearchResult {
    type: "block" | "message"
    id: string
    relevance: number
    label: string
    preview: string
    action: string
}

function countOccurrences(text: string, term: string): number {
    if (!text || !term) return 0
    let count = 0
    let idx = 0
    while ((idx = text.indexOf(term, idx)) !== -1) {
        count++
        idx += term.length
    }
    return count
}

function buildSearchPreview(text: string, firstTerm: string): string {
    if (!text) return ""
    const matchIdx = text.toLowerCase().indexOf(firstTerm)
    if (matchIdx >= 0) {
        const start = Math.max(0, matchIdx - 50)
        const end = Math.min(text.length, matchIdx + 150)
        return (
            (start > 0 ? "..." : "") + text.substring(start, end) + (end < text.length ? "..." : "")
        )
    }
    return text.substring(0, 200) + (text.length > 200 ? "..." : "")
}

export function createSearchContextTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: SEARCH_CONTEXT_TOOL_DESCRIPTION,
        args: {
            query: tool.schema.string().describe("Search query — keywords or phrase to find"),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum results to return (default: 10)"),
            deep: tool.schema
                .boolean()
                .optional()
                .describe(
                    "If true, also search visible (uncompressed) messages. Slower but more thorough (default: false)",
                ),
        },
        async execute(args) {
            const query = (args.query || "").toLowerCase().trim()
            const limit = args.limit ?? 10

            if (!query) {
                return "Error: query is required."
            }

            const queryTerms = query.split(/\s+/).filter((t) => t.length > 0)
            const results: SearchResult[] = []
            const MIN_RELEVANCE = 0.1

            const blocksById = ctx.state.prune.messages.blocksById
            for (const [blockId, block] of blocksById) {
                if (!block.active) continue

                const topic = (block.topic || "").toLowerCase()
                const summary = (block.summary || "").toLowerCase()

                // TF-based scoring: count ALL occurrences, weight by position
                let relevance = 0
                let termsHit = 0
                for (const term of queryTerms) {
                    let termHit = false
                    // Topic matches (high weight, capped per term)
                    const topicCount = countOccurrences(topic, term)
                    if (topicCount > 0) {
                        relevance += Math.min(topicCount * 0.15, 0.45)
                        termHit = true
                    }
                    // Summary matches (lower weight, compounds with frequency)
                    const summaryCount = countOccurrences(summary, term)
                    if (summaryCount > 0) {
                        relevance += Math.min(summaryCount * 0.04, 0.2)
                        termHit = true
                    }
                    if (termHit) termsHit++
                }
                // All-terms-matched bonus: 20% boost
                if (termsHit === queryTerms.length && queryTerms.length > 1) {
                    relevance *= 1.2
                }
                // Exact phrase match bonus
                if (queryTerms.length > 1 && query.includes(" ")) {
                    if (topic.includes(query) || summary.includes(query)) {
                        relevance += 0.25
                    }
                }
                relevance = Math.min(relevance, 1.0)

                if (relevance < MIN_RELEVANCE) continue

                const origSummary = block.summary || ""
                const preview = buildSearchPreview(origSummary, queryTerms[0])

                results.push({
                    type: "block",
                    id: `b${blockId}`,
                    relevance,
                    label: block.topic || "(no topic)",
                    preview,
                    action: `→ decompress(b${blockId}) for full content`,
                })
            }

            results.sort((a, b) => b.relevance - a.relevance)
            const limited = results.slice(0, limit)

            if (limited.length === 0) {
                return `No matches found for "${args.query}". Try different keywords.`
            }

            const lines: string[] = []
            lines.push(
                `🔍 Found ${results.length} matches for "${args.query}" (showing top ${limited.length}):`,
            )
            lines.push("")

            for (const result of limited) {
                const icon = result.type === "block" ? "📦" : "📄"
                const stars = "⭐".repeat(Math.ceil(result.relevance * 5))
                lines.push(
                    `${icon} [${result.id}] ${stars} (${result.relevance.toFixed(2)}) "${result.label}"`,
                )
                lines.push(`   ${result.preview}`)
                lines.push(`   ${result.action}`)
                lines.push("")
            }

            let output = lines.join("\n")
            if (output.length > 3000) {
                output =
                    output.substring(0, 3000) +
                    "\n... (truncated, refine query for more specific results)"
            }

            return output
        },
    })
}
