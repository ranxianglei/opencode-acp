import type { SessionState, CompressionBlock, WithParts } from "./types"

export function isCompacted(state: SessionState, msg: WithParts): boolean {
    const info = msg.info
    if (!info) return false

    const lastCompaction = state.lastCompaction
    if (lastCompaction > 0) {
        const created = info.time?.created
        if (created !== undefined) {
            if (created < lastCompaction) return true
            if (created === lastCompaction && info.summary === true) return true
        }
    }

    const entry = state.prune.messages.byMessageId.get(info.id)
    if (entry && entry.activeBlockIds.length > 0) return true

    return false
}

export function isMessageCompacted(state: SessionState, msg: WithParts): boolean {
    return isCompacted(state, msg)
}

export function getActiveBlocks(state: SessionState): CompressionBlock[] {
    const messages = state.prune.messages
    const out: CompressionBlock[] = []
    for (const id of messages.activeBlockIds) {
        const block = messages.blocksById.get(id)
        if (block) out.push(block)
    }
    return out
}

export function getBlockByAnchor(
    state: SessionState,
    anchorId: string,
): CompressionBlock | undefined {
    const messages = state.prune.messages
    const blockId = messages.activeByAnchorMessageId.get(anchorId)
    if (blockId === undefined) return undefined
    return messages.blocksById.get(blockId)
}

export function getMessageRef(state: SessionState, rawId: string): string | undefined {
    return state.messageIds.byRawId.get(rawId)
}

export function getRawIdByRef(state: SessionState, ref: string): string | undefined {
    return state.messageIds.byRef.get(ref)
}
