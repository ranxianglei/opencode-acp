import type { SessionState, WithParts } from "../state/types"
import type { Logger } from "../infra/logger"
import { deactivateBlock } from "../state/mutations/blocks"

export function syncCompressionBlocks(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): number {
    const existingIds = new Set(messages.map((m) => m.info.id))
    let deactivatedCount = 0

    const activeBlockIds = [...state.prune.messages.activeBlockIds]

    for (const blockId of activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) continue

        const allMessagesGone = block.effectiveMessageIds.every(
            (msgId) => !existingIds.has(msgId),
        )

        if (allMessagesGone && block.effectiveMessageIds.length > 0) {
            deactivateBlock(state, blockId)
            deactivatedCount++

            for (const msgId of block.effectiveMessageIds) {
                const entry = state.prune.messages.byMessageId.get(msgId)
                if (entry) {
                    entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockId)
                }
            }

            logger.info("Deactivated orphaned compression block", {
                blockId,
                messageIds: block.effectiveMessageIds,
            })
        }
    }

    return deactivatedCount
}
