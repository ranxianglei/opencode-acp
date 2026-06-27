import type { SessionState, WithParts } from "../state/types"
import type { Logger } from "../infra/logger"

function sortBlocksByCreation(
    a: { createdAt: number; blockId: number },
    b: { createdAt: number; blockId: number },
): number {
    const createdAtDiff = a.createdAt - b.createdAt
    if (createdAtDiff !== 0) {
        return createdAtDiff
    }
    return a.blockId - b.blockId
}

export function syncCompressionBlocks(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): number {
    const messagesState = state.prune.messages
    if (!messagesState?.blocksById?.size) {
        return 0
    }

    const messageIds = new Set(messages.map((msg) => msg.info.id))
    const previousActiveBlockIds = new Set<number>(
        Array.from(messagesState.blocksById.values())
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )

    messagesState.activeBlockIds.clear()
    messagesState.activeByAnchorMessageId.clear()

    const now = Date.now()
    const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation)

    for (const block of orderedBlocks) {
        if (block.deactivatedByUser) {
            block.active = false
            if (block.deactivatedAt === undefined) {
                block.deactivatedAt = now
            }
            block.deactivatedByBlockId = undefined
            continue
        }

        if (
            typeof block.anchorMessageId === "string" &&
            block.anchorMessageId.length > 0 &&
            !messageIds.has(block.anchorMessageId)
        ) {
            if (!messagesState.byMessageId.has(block.anchorMessageId)) {
                block.active = false
                block.deactivatedAt = now
                block.deactivatedByBlockId = undefined
                continue
            }
        }

        for (const consumedBlockId of block.consumedBlockIds) {
            if (!messagesState.activeBlockIds.has(consumedBlockId)) {
                continue
            }

            const consumedBlock = messagesState.blocksById.get(consumedBlockId)
            if (consumedBlock) {
                consumedBlock.active = false
                consumedBlock.deactivatedAt = now
                consumedBlock.deactivatedByBlockId = block.blockId

                const mappedBlockId = messagesState.activeByAnchorMessageId.get(
                    consumedBlock.anchorMessageId,
                )
                if (mappedBlockId === consumedBlock.blockId) {
                    messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
                }
            }

            messagesState.activeBlockIds.delete(consumedBlockId)
        }

        block.active = true
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
        messagesState.activeBlockIds.add(block.blockId)
        if (messageIds.has(block.anchorMessageId)) {
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
        }
    }

    for (const entry of messagesState.byMessageId.values()) {
        const allBlockIds = Array.isArray(entry.allBlockIds)
            ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
            : []

        entry.allBlockIds = allBlockIds
        entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id))
    }

    const nextActiveBlockIds = messagesState.activeBlockIds
    let deactivatedCount = 0
    let reactivatedCount = 0

    for (const blockId of previousActiveBlockIds) {
        if (!nextActiveBlockIds.has(blockId)) {
            deactivatedCount++
        }
    }
    for (const blockId of nextActiveBlockIds) {
        if (!previousActiveBlockIds.has(blockId)) {
            reactivatedCount++
        }
    }

    if (deactivatedCount > 0 || reactivatedCount > 0) {
        logger.info("Synced compress block state", {
            deactivatedCount,
            reactivatedCount,
        })
    }

    return deactivatedCount
}
