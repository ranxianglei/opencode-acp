import type { SessionState, WithParts } from "../state/types"
import type { Logger } from "../infra/logger"
import { formatBlockRef, parseBoundaryId } from "../infra/message-refs"
import { isIgnoredUserMessage } from "../messages/query"
import { filterMessages } from "../messages/shape"
import { countTokensSync } from "../infra/token-counter"
import type {
    BoundaryReference,
    SearchContext,
    SelectionResolution,
} from "./types"

export interface ResolvedBoundary {
    startIndex: number
    endIndex: number
    startMessageId: string
    endMessageId: string
    swapped: boolean
}

export function resolveBoundary(
    state: SessionState,
    messages: WithParts[],
    startId: string,
    endId: string,
    logger: Logger,
): ResolvedBoundary | null {
    const startIdx = findMessageIndexByRef(state, messages, startId)
    const endIdx = findMessageIndexByRef(state, messages, endId)

    if (startIdx === -1) {
        logger.warn("Could not resolve start boundary", { startId })
        return null
    }
    if (endIdx === -1) {
        logger.warn("Could not resolve end boundary", { endId })
        return null
    }

    let startIndex = startIdx
    let endIndex = endIdx
    let swapped = false

    if (startIndex > endIndex) {
        const tmp = startIndex
        startIndex = endIndex
        endIndex = tmp
        swapped = true
        logger.info("Auto-swapped reversed compress boundaries", {
            originalStart: startId,
            originalEnd: endId,
            resolvedStart: messages[startIndex]!.info.id,
            resolvedEnd: messages[endIndex]!.info.id,
        })
    }

    return {
        startIndex,
        endIndex,
        startMessageId: messages[startIndex]!.info.id,
        endMessageId: messages[endIndex]!.info.id,
        swapped,
    }
}

export function resolveMessageRef(
    state: SessionState,
    messages: WithParts[],
    ref: string,
    logger: Logger,
): WithParts | null {
    const idx = findMessageIndexByRef(state, messages, ref)
    if (idx === -1) {
        logger.warn("Could not resolve message ref", { ref })
        return null
    }
    return messages[idx]!
}

function findMessageIndexByRef(
    state: SessionState,
    messages: WithParts[],
    ref: string,
): number {
    const rawId = state.messageIds.byRef.get(ref)
    if (rawId) {
        return messages.findIndex((m) => m.info.id === rawId)
    }

    return messages.findIndex((m) => m.info.id === ref)
}

export function collectMessageIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const ids: string[] = []
    for (let i = startIndex; i <= endIndex && i < messages.length; i++) {
        ids.push(messages[i]!.info.id)
    }
    return ids
}

export function collectToolCallIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const ids: string[] = []
    for (let i = startIndex; i <= endIndex && i < messages.length; i++) {
        const parts = Array.isArray(messages[i]!.parts) ? messages[i]!.parts : []
        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as { type: "tool"; callID: string }
                ids.push(toolPart.callID)
            }
        }
    }
    return ids
}

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

    const summaryByBlockId = new Map<number, any>()
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

    if (!startReference) {
        issues.push(
            `startId ${parsedStartId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (!endReference) {
        issues.push(
            `endId ${parsedEndId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }

    if (!startReference || !endReference) {
        throw new Error("Failed to resolve boundary IDs")
    }

    if (startReference.rawIndex > endReference.rawIndex) {
        [startReference, endReference] = [endReference, startReference]
    }

    return { startReference, endReference }
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
            if (part.type !== "tool" || !(part as any).callID) {
                continue
            }
            const callID = (part as any).callID
            if (toolSeen.has(callID)) {
                continue
            }
            toolSeen.add(callID)
            toolIds.push(callID)
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

function countAllMessageTokens(msg: WithParts): number {
    let total = 0
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        const p = part as { type?: string; text?: unknown; state?: { output?: unknown; input?: unknown } }
        if (typeof p.text === "string") {
            total += countTokensSync(p.text)
        }
        if (p.type === "tool" && p.state) {
            if (typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
            if (p.state.input && typeof p.state.input === "object") {
                try {
                    total += countTokensSync(JSON.stringify(p.state.input))
                } catch {
                    void 0
                }
            }
        }
    }
    return total
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
