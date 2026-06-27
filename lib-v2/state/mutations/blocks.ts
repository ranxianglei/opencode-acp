import type { SessionState, CompressionBlock } from "../types"
import type { CompressionMode } from "../../config/types"

export interface AllocateBlockInput {
    topic: string
    summary: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressedTokens: number
    summaryTokens: number
    batchTopic?: string
    compressCallId?: string
    mode?: CompressionMode
    durationMs?: number
    runId?: number
    directMessageIds?: string[]
    directToolIds?: string[]
    effectiveMessageIds?: string[]
    effectiveToolIds?: string[]
    includedBlockIds?: number[]
    consumedBlockIds?: number[]
    parentBlockIds?: number[]
}

export interface DeactivationReason {
    byBlockId?: number
    byUser?: boolean
}

export function allocateBlock(state: SessionState, input: AllocateBlockInput): CompressionBlock {
    const messages = state.prune.messages
    const blockId = messages.nextBlockId
    const runId = input.runId ?? messages.nextRunId

    const block: CompressionBlock = {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: input.compressedTokens,
        summaryTokens: input.summaryTokens,
        durationMs: input.durationMs ?? 0,
        mode: input.mode,
        topic: input.topic,
        batchTopic: input.batchTopic,
        startId: input.startId,
        endId: input.endId,
        anchorMessageId: input.anchorMessageId,
        compressMessageId: input.compressMessageId,
        compressCallId: input.compressCallId,
        includedBlockIds: input.includedBlockIds ?? [],
        consumedBlockIds: input.consumedBlockIds ?? [],
        parentBlockIds: input.parentBlockIds ?? [],
        directMessageIds: input.directMessageIds ?? [],
        directToolIds: input.directToolIds ?? [],
        effectiveMessageIds: input.effectiveMessageIds ?? [],
        effectiveToolIds: input.effectiveToolIds ?? [],
        createdAt: Date.now(),
        summary: input.summary,
        survivedCount: 0,
        generation: "young",
    }

    messages.blocksById.set(blockId, block)
    messages.activeBlockIds.add(blockId)
    if (input.anchorMessageId) {
        messages.activeByAnchorMessageId.set(input.anchorMessageId, blockId)
    }

    messages.nextBlockId = blockId + 1
    if (input.runId === undefined) {
        messages.nextRunId = runId + 1
    }

    return block
}

export function deactivateBlock(
    state: SessionState,
    blockId: number,
    reason?: DeactivationReason,
): boolean {
    const messages = state.prune.messages
    const block = messages.blocksById.get(blockId)
    if (!block) return false

    block.active = false
    block.deactivatedAt = Date.now()
    if (reason?.byBlockId !== undefined) {
        block.deactivatedByBlockId = reason.byBlockId
    }
    if (reason?.byUser) {
        block.deactivatedByUser = true
    }

    messages.activeBlockIds.delete(blockId)
    if (block.anchorMessageId) {
        const current = messages.activeByAnchorMessageId.get(block.anchorMessageId)
        if (current === blockId) {
            messages.activeByAnchorMessageId.delete(block.anchorMessageId)
        }
    }

    return true
}

export function consumeBlocks(
    state: SessionState,
    blockIds: number[],
    consumerBlockId: number,
): void {
    const consumer = state.prune.messages.blocksById.get(consumerBlockId)
    if (!consumer) return

    for (const blockId of blockIds) {
        deactivateBlock(state, blockId, { byBlockId: consumerBlockId })
        if (!consumer.consumedBlockIds.includes(blockId)) {
            consumer.consumedBlockIds.push(blockId)
        }
    }
}
