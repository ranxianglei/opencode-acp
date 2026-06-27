import type { SessionState, CompressionBlock } from "../types"

export function ageBlocks(state: SessionState): number {
    let aged = 0
    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.active) continue
        block.survivedCount++
        aged++
    }
    return aged
}

export function promoteGeneration(state: SessionState, threshold: number): number {
    let promoted = 0
    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.active) continue
        if (block.generation === "old") continue
        if (block.survivedCount >= threshold) {
            block.generation = "old"
            promoted++
        }
    }
    return promoted
}

export function truncateSummary(block: CompressionBlock, maxLength: number): boolean {
    if (block.summary.length > maxLength) {
        block.summary = block.summary.slice(0, maxLength)
        return true
    }
    return false
}
