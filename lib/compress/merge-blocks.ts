import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs, formatBlockRef, parseBlockRef } from "../message-ids"
import { fetchSessionMessages } from "./search"
import { syncCompressionBlocks } from "../messages"
import { countTokens } from "../token-utils"
import {
    allocateBlockId,
    allocateRunId,
    wrapCompressedSummary,
    COMPRESSED_BLOCK_HEADER,
} from "./state"

function parseSingleBlockId(value: string): number | null {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) {
        return null
    }
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) {
        return blockRef
    }
    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }
    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseBlockIdToken(token: string): number[] | null {
    const normalized = token.trim().toLowerCase()
    if (normalized.length === 0) {
        return null
    }

    const commaParts = normalized.split(",").map((p) => p.trim()).filter(Boolean)
    if (commaParts.length === 0) {
        return null
    }

    const ids: number[] = []
    for (const part of commaParts) {
        if (part.includes("-")) {
            const rangeParts = part.split("-")
            if (rangeParts.length !== 2) {
                return null
            }
            const start = parseSingleBlockId(rangeParts[0]!)
            const end = parseSingleBlockId(rangeParts[1]!)
            if (start === null || end === null || end < start) {
                return null
            }
            for (let id = start; id <= end; id++) {
                ids.push(id)
            }
        } else {
            const id = parseSingleBlockId(part)
            if (id === null) {
                return null
            }
            ids.push(id)
        }
    }

    return [...new Set(ids)].sort((a, b) => a - b)
}

// --- Summary helpers ---

function extractSummaryBody(summary: string): string {
    let body = summary
    const headerPrefix = COMPRESSED_BLOCK_HEADER + "\n"
    if (body.startsWith(headerPrefix)) {
        body = body.slice(headerPrefix.length)
    }
    body = body.replace(/\n]*>b\d+<\/dcp-message-id>$/, "")
    return body.trim()
}

function buildMergedTopic(sourceBlocks: CompressionBlock[]): string {
    const uniqueTopics: string[] = []
    const seen = new Set<string>()
    for (const block of sourceBlocks) {
        const topic = (block.topic || "(no topic)").replace(/\s+/g, " ").trim()
        if (topic.length === 0 || seen.has(topic)) {
            continue
        }
        seen.add(topic)
        uniqueTopics.push(topic)
    }
    if (uniqueTopics.length === 0) {
        return "Merged blocks"
    }
    if (uniqueTopics.length === 1) {
        return uniqueTopics[0]!
    }
    return `Merged: ${uniqueTopics.join(" + ")}`
}

function formatRangeOrList(ids: number[]): string {
    if (ids.length === 0) {
        return ""
    }
    if (ids.length === 1) {
        return formatBlockRef(ids[0]!)
    }
    let contiguous = true
    for (let i = 1; i < ids.length; i++) {
        if (ids[i]! - ids[i - 1]! !== 1) {
            contiguous = false
            break
        }
    }
    if (contiguous) {
        return `${formatBlockRef(ids[0]!)}-${formatBlockRef(ids[ids.length - 1]!)}`
    }
    return ids.map((id) => formatBlockRef(id)).join(", ")
}

function formatTokenCount(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(".0", "")}K` : `${tokens}`
}

const MERGE_BLOCKS_DESCRIPTION = `Merge multiple compressed blocks into a single block.

Use this when you have many small compressed blocks covering related topics.
Merging reduces block count and total summary overhead.

Argument: blockIds — block references to merge. Supports ranges ("b421-b428"),
comma-separated lists ("b421,b422,b423"), and mixed ("b398-b407,b416-b419").

Argument: summary — OPTIONAL but recommended. Write a SHORT unified summary
that captures the key information from all source blocks. This produces much
better compression than auto-concatenation. Include (bN) placeholders for
any source blocks referenced in the summary. If omitted, summaries are
auto-concatenated (less effective).

All source blocks must be active. After merge, source blocks are deactivated
and a new combined block is created. You can still decompress source blocks
later if needed (before GC).

Example: merge_blocks with blockIds "b12-b14" and summary "## ACP optimization
results\\nCombined findings from (b12), (b13), (b14)..."`

function buildSchema() {
    return {
        blockIds: tool.schema
            .string()
            .describe(
                'Block references to merge. Supports ranges ("b421-b428"), lists ("b421,b422,b423"), and mixed ("b398-b407,b416-b419").',
            ),
        summary: tool.schema
            .string()
            .optional()
            .describe(
                "Short unified summary covering all source blocks. Include (bN) placeholders for referenced blocks. If omitted, auto-concatenated (less effective).",
            ),
    }
}

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
    messageID: string
}

async function prepareMergeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<WithParts[]> {
    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title: "Merge blocks" })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)
    return rawMessages
}

export function createMergeBlocksTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: MERGE_BLOCKS_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const rawMessages = await prepareMergeSession(ctx, toolCtx as RunContext)

            const requestedIds = parseBlockIdToken(String(args.blockIds))
            if (requestedIds === null || requestedIds.length === 0) {
                return `Error: Could not parse block IDs "${args.blockIds}". Use format "b421-b428" or "b421,b422,b423".`
            }

            syncCompressionBlocks(ctx.state, ctx.logger, rawMessages)
            const messagesState = ctx.state.prune.messages

            const sourceBlocks: CompressionBlock[] = []
            const missingIds: number[] = []
            const inactiveIds: number[] = []
            const seen = new Set<number>()

            for (const id of requestedIds) {
                if (seen.has(id)) {
                    continue
                }
                seen.add(id)
                const block = messagesState.blocksById.get(id)
                if (!block) {
                    missingIds.push(id)
                    continue
                }
                if (!block.active) {
                    inactiveIds.push(id)
                    continue
                }
                sourceBlocks.push(block)
            }

            if (missingIds.length > 0) {
                const refs = missingIds.map((id) => formatBlockRef(id)).join(", ")
                return `Error: Block${missingIds.length === 1 ? "" : "s"} ${refs} not found.`
            }

            if (inactiveIds.length > 0) {
                const refs = inactiveIds.map((id) => formatBlockRef(id)).join(", ")
                return `Error: Block${inactiveIds.length === 1 ? "" : "s"} ${refs} not active. Only active blocks can be merged.`
            }

            if (sourceBlocks.length < 2) {
                return `Need at least two blocks to merge. Nothing to do.`
            }

            sourceBlocks.sort((a, b) => a.blockId - b.blockId)
            const sourceIds = sourceBlocks.map((block) => block.blockId)

            const mergedBody = args.summary
                ? String(args.summary)
                : sourceBlocks.map((block) => {
                      const topic = (block.topic || "(no topic)").replace(/\s+/g, " ").trim()
                      const body = extractSummaryBody(block.summary)
                      const header = `(b${block.blockId}) ${topic}`
                      return body.length > 0 ? `${header}\n${body}` : header
                  }).join("\n---\n")

            const newBlockId = allocateBlockId(ctx.state)
            const newSummary = wrapCompressedSummary(newBlockId, mergedBody)
            const newSummaryTokens = countTokens(newSummary)

            const oldest = sourceBlocks[0]!
            const newest = sourceBlocks[sourceBlocks.length - 1]!

            const effectiveMessageIds = new Set<string>()
            const effectiveToolIds = new Set<string>()
            for (const block of sourceBlocks) {
                for (const id of block.effectiveMessageIds) effectiveMessageIds.add(id)
                for (const id of block.effectiveToolIds) effectiveToolIds.add(id)
            }

            const sourceTokens = sourceBlocks.reduce(
                (sum, block) => sum + (block.summaryTokens || Math.round(block.summary.length / 4)),
                0,
            )

            const mergedTopic = buildMergedTopic(sourceBlocks)
            const createdAt = Date.now()

            const mergedBlock: CompressionBlock = {
                blockId: newBlockId,
                runId: allocateRunId(ctx.state),
                active: true,
                deactivatedByUser: false,
                compressedTokens: 0,
                summaryTokens: newSummaryTokens,
                durationMs: 0,
                mode: "range",
                topic: mergedTopic,
                batchTopic: mergedTopic,
                startId: oldest.startId,
                endId: newest.endId,
                anchorMessageId: oldest.anchorMessageId,
                compressMessageId: toolCtx.messageID,
                compressCallId: undefined,
                includedBlockIds: [...sourceIds],
                consumedBlockIds: [...sourceIds],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [...effectiveMessageIds],
                effectiveToolIds: [...effectiveToolIds],
                createdAt,
                summary: newSummary,
                survivedCount: 0,
                generation: "old",
            }

            messagesState.blocksById.set(newBlockId, mergedBlock)
            syncCompressionBlocks(ctx.state, ctx.logger, rawMessages)

            const savedTokens = Math.max(0, sourceTokens - newSummaryTokens)
            await saveSessionState(ctx.state, ctx.logger)

            ctx.logger.info("merge_blocks tool completed", {
                newBlockId,
                sourceBlockIds: sourceIds,
                savedTokens,
                sourceTokens,
                newSummaryTokens,
            })

            const rangeLabel = formatRangeOrList(sourceIds)
            const lines: string[] = [
                `Merged ${sourceBlocks.length} block${sourceBlocks.length === 1 ? "" : "s"} (${rangeLabel}) into ${formatBlockRef(newBlockId)}.`,
                `Summary: ~${formatTokenCount(savedTokens)} saved (~${formatTokenCount(sourceTokens)} → ~${formatTokenCount(newSummaryTokens)}).`,
                `Deactivated: ${sourceIds.map((id) => formatBlockRef(id)).join(", ")}.`,
            ]
            return lines.join("\n")
        },
    })
}
