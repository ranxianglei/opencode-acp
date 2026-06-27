import type { SessionState, WithParts } from "../state/types"
import type { Logger } from "../infra/logger"

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
