import type { SessionState } from "../types"

export type TokenCountSource = number | Map<string, number>

function resolveTokenCount(msgId: string, tokenCount: TokenCountSource): number {
    if (typeof tokenCount === "number") return tokenCount
    return tokenCount.get(msgId) ?? 0
}

export function markPruned(
    state: SessionState,
    messageIds: string[],
    blockId: number,
    tokenCount: TokenCountSource,
): void {
    const byMessageId = state.prune.messages.byMessageId
    for (const msgId of messageIds) {
        const existing = byMessageId.get(msgId)
        if (existing) {
            if (!existing.allBlockIds.includes(blockId)) {
                existing.allBlockIds.push(blockId)
            }
            if (!existing.activeBlockIds.includes(blockId)) {
                existing.activeBlockIds.push(blockId)
            }
        } else {
            byMessageId.set(msgId, {
                tokenCount: resolveTokenCount(msgId, tokenCount),
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            })
        }
    }
}

export function unmarkPruned(state: SessionState, messageIds: string[]): void {
    const byMessageId = state.prune.messages.byMessageId
    for (const msgId of messageIds) {
        byMessageId.delete(msgId)
    }
}

export function updateActiveBlockIds(state: SessionState): void {
    const messages = state.prune.messages
    const activeSet = messages.activeBlockIds
    for (const entry of messages.byMessageId.values()) {
        entry.activeBlockIds = entry.allBlockIds.filter((id) => activeSet.has(id))
    }
}
