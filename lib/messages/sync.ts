import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { Logger } from "../logger"

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

function sameBlockIds(left: Set<number>, right: Set<number>): boolean {
    if (left.size !== right.size) return false
    return Array.from(left).every((id) => right.has(id))
}

export const syncCompressionBlocks = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): boolean => {
    const messagesState = state.prune.messages
    if (!messagesState?.blocksById?.size) {
        if (!messagesState.membershipsVerified) {
            messagesState.activeBlockIds.clear()
            messagesState.activeByAnchorMessageId.clear()
            for (const entry of messagesState.byMessageId.values()) {
                entry.allBlockIds = Array.isArray(entry.allBlockIds)
                    ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
                    : []
                entry.activeBlockIds = []
            }
            messagesState.membershipsVerified = true
            return true
        }
        return false
    }

    const messageIds = new Set(messages.map((msg) => msg.info.id))

    // [Issue #384] Verified-state synchronization: the full replay below walks
    // EVERY historical block (unbounded growth with session length). Block
    // liveness only changes through structureVersion-bumped mutations, so when
    // the version matches the last sync, liveness is already at its fixed
    // point. The only thing that can drift between transforms is the anchor
    // map — opencode may have removed or added messages since — so rebuild it
    // from ACTIVE blocks only (bounded) and skip the rest.
    const structureVersion = messagesState.structureVersion ?? 0
    if (messagesState.lastSyncedStructureVersion === structureVersion) {
        const activeBlocks = [...messagesState.activeBlockIds]
            .map((id) => messagesState.blocksById.get(id))
            .filter((b): b is CompressionBlock => b !== undefined)
            .sort(sortBlocksByCreation)
        const nextAnchorMap = new Map<string, number>()
        for (const block of activeBlocks) {
            if (!messageIds.has(block.anchorMessageId)) continue
            nextAnchorMap.set(block.anchorMessageId, block.blockId)
        }
        const previous = messagesState.activeByAnchorMessageId
        if (
            previous.size !== nextAnchorMap.size ||
            ![...nextAnchorMap.entries()].every(([anchor, id]) => previous.get(anchor) === id)
        ) {
            previous.clear()
            for (const [anchor, id] of nextAnchorMap) {
                previous.set(anchor, id)
            }
        }
        return false
    }

    const previousActiveBlockIds = new Set<number>(
        Array.from(messagesState.blocksById.values())
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )
    const indexedActiveBlockIds = new Set(messagesState.activeBlockIds)

    messagesState.activeBlockIds.clear()
    messagesState.activeByAnchorMessageId.clear()

    const now = Date.now()
    const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation)

    // [PATCH Bug 3] Removed compressMessageId presence check.
    // Blocks should remain active even if the compress tool call message was
    // removed by opencode's internal compaction. The block's existence IS proof
    // that compression happened.
    for (const block of orderedBlocks) {
        if (block.deactivatedByUser || block.deactivatedByUserDeep) {
            block.active = false
            if (block.deactivatedAt === undefined) {
                block.deactivatedAt = now
            }
            block.deactivatedByBlockId = undefined
            continue
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

    const membershipsRebuilt =
        !messagesState.membershipsVerified ||
        !sameBlockIds(indexedActiveBlockIds, messagesState.activeBlockIds)
    if (membershipsRebuilt) {
        for (const entry of messagesState.byMessageId.values()) {
            const allBlockIds = Array.isArray(entry.allBlockIds)
                ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
                : []

            entry.allBlockIds = allBlockIds
            entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id))
        }
        messagesState.membershipsVerified = true
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

    messagesState.lastSyncedStructureVersion = structureVersion
    return membershipsRebuilt || deactivatedCount > 0 || reactivatedCount > 0
}
