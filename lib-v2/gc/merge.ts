import type { CompressionBlock, SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import { countTokensSync, getCurrentTokenUsage } from "../infra/token-counter"
import { formatBlockRef } from "../infra/message-refs"

export interface MergeMarkedResult {
    mergedCount: number
    savedTokens: number
}

export interface BatchCleanupResult {
    tier: 0 | 1 | 2 | 3
    action: "none" | "nudge" | "merge"
    mergedCount: number
    savedTokens: number
    nudgeText?: string
}

const DEFAULT_BATCH_CLEANUP = {
    lowThreshold: "60%" as const,
    highThreshold: "75%" as const,
    forceThreshold: "90%" as const,
}

function resolveBatchCleanup(gc: PluginConfig["gc"]) {
    return gc.batchCleanup ?? DEFAULT_BATCH_CLEANUP
}

function percentToTokens(
    value: number | `${number}%`,
    modelContextLimit: number,
): number {
    if (typeof value === "number") return value
    const percent = parseFloat(value.slice(0, -1))
    if (isNaN(percent)) return modelContextLimit
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    return Math.round((clamped / 100) * modelContextLimit)
}

function collectActiveOldGenBlocks(
    state: SessionState,
    maxOldGenSummaryLength: number,
): CompressionBlock[] {
    const blocks: CompressionBlock[] = []
    const ids = Array.from(state.prune.messages.activeBlockIds).sort((a, b) => a - b)
    for (const id of ids) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block || !block.active) continue
        if (
            block.generation === "old" ||
            block.generation === undefined ||
            block.summary.length > maxOldGenSummaryLength
        ) {
            blocks.push(block)
        }
    }
    return blocks
}

function collectActiveMarkedBlocks(state: SessionState): CompressionBlock[] {
    const ids = Array.from(state.prune.messages.markedForCleanup).sort((a, b) => a - b)
    const blocks: CompressionBlock[] = []
    for (const id of ids) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block || !block.active) continue
        blocks.push(block)
    }
    return blocks
}

function extractSummaryBody(summary: string): string {
    return summary
        .replace(/<dcp-message-id>[^<]*<\/dcp-message-id>$/, "")
        .replace(/<dcp-system-reminder>[^]*?<\/dcp-system-reminder>$/, "")
        .trim()
}

function truncateMergedSummary(merged: string, maxLength: number): string {
    if (merged.length <= maxLength) return merged

    const blocks = merged.split("\n---\n")
    const headers = blocks
        .map((b) => b.split("\n")[0] ?? "")
        .filter((h) => h.trim().length > 0)

    const marker = "\n...\n[merged and truncated by batch cleanup]"
    const budget = Math.max(0, maxLength - marker.length)
    const headerJoin = headers.join("\n")

    if (headerJoin.length <= budget) {
        return headerJoin + marker
    }
    return headerJoin.slice(0, budget) + marker
}

export function mergeMarkedBlocks(
    state: SessionState,
    markedIds: number[],
    maxMergedLength: number,
): MergeMarkedResult {
    const sortedIds = [...new Set(markedIds)].filter(
        (id) => Number.isInteger(id) && id > 0,
    ).sort((a, b) => a - b)

    const sourceBlocks: CompressionBlock[] = []
    for (const id of sortedIds) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block || !block.active) continue
        if (!sourceBlocks.some((b) => b.blockId === id)) {
            sourceBlocks.push(block)
        }
    }

    if (sourceBlocks.length < 2) {
        return { mergedCount: 0, savedTokens: 0 }
    }

    const messagesState = state.prune.messages
    const newBlockId = messagesState.nextBlockId++
    const newRunId = messagesState.nextRunId++

    const bodies = sourceBlocks.map((block) => extractSummaryBody(block.summary))
    const mergedRaw = bodies.join("\n---\n")
    const mergedBody = truncateMergedSummary(mergedRaw, maxMergedLength)
    const newSummary = `[Compressed block ${newBlockId}]\n${mergedBody}`
    const newSummaryTokens = countTokensSync(newSummary)

    const oldest = sourceBlocks[0]!
    const newest = sourceBlocks[sourceBlocks.length - 1]!

    const effectiveMessageIds = new Set<string>()
    const effectiveToolIds = new Set<string>()
    for (const block of sourceBlocks) {
        for (const id of block.effectiveMessageIds) effectiveMessageIds.add(id)
        for (const id of block.effectiveToolIds) effectiveToolIds.add(id)
    }

    const sourceIds = sourceBlocks.map((b) => b.blockId)

    const mergedBlock: CompressionBlock = {
        blockId: newBlockId,
        runId: newRunId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: newSummaryTokens,
        durationMs: 0,
        mode: "range",
        topic: "Batch merge cleanup",
        batchTopic: "Batch merge cleanup",
        startId: oldest.startId,
        endId: newest.endId,
        anchorMessageId: oldest.anchorMessageId,
        compressMessageId: "",
        compressCallId: undefined,
        includedBlockIds: [...sourceIds],
        consumedBlockIds: [...sourceIds],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt: Date.now(),
        summary: newSummary,
        survivedCount: 0,
        generation: "old",
    }

    const now = Date.now()
    for (const block of sourceBlocks) {
        block.active = false
        block.deactivatedAt = now
        block.deactivatedByBlockId = newBlockId
        if (!block.parentBlockIds.includes(newBlockId)) {
            block.parentBlockIds.push(newBlockId)
        }
        messagesState.activeBlockIds.delete(block.blockId)
        const mappedId = messagesState.activeByAnchorMessageId.get(block.anchorMessageId)
        if (mappedId === block.blockId) {
            messagesState.activeByAnchorMessageId.delete(block.anchorMessageId)
        }
    }

    messagesState.blocksById.set(newBlockId, mergedBlock)
    messagesState.activeBlockIds.add(newBlockId)
    messagesState.activeByAnchorMessageId.set(mergedBlock.anchorMessageId, newBlockId)

    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) continue
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => !sourceIds.includes(id))
        if (!entry.activeBlockIds.includes(newBlockId)) {
            entry.activeBlockIds.push(newBlockId)
        }
        if (!entry.allBlockIds.includes(newBlockId)) {
            entry.allBlockIds.push(newBlockId)
        }
    }

    for (const id of sourceIds) {
        messagesState.markedForCleanup.delete(id)
    }

    const sourceTokens = sourceBlocks.reduce(
        (sum, block) => sum + (block.summaryTokens || Math.round(block.summary.length / 4)),
        0,
    )
    const savedTokens = Math.max(0, sourceTokens - newSummaryTokens)

    return { mergedCount: sourceBlocks.length, savedTokens }
}

function buildNudgeText(state: SessionState, maxMergedLength: number): string | undefined {
    const blocks = collectActiveMarkedBlocks(state)
    if (blocks.length < 1) return undefined

    const refs = blocks.map((b) => formatBlockRef(b.blockId)).join(", ")
    const sourceTokens = blocks.reduce(
        (sum, block) => sum + (block.summaryTokens || Math.round(block.summary.length / 4)),
        0,
    )
    const estimatedMergedTokens = Math.round(maxMergedLength / 4)
    const estimatedSavings = Math.max(0, sourceTokens - estimatedMergedTokens)

    return [
        `${blocks.length} block(s) marked for batch cleanup (${refs}).`,
        `Merge-compressing them would free ~${estimatedSavings} tokens.`,
        blocks.length >= 2
            ? "They will auto-merge when context pressure reaches the high threshold."
            : "A single marked block won't auto-merge on its own — use compress to consolidate it, or unmark_block if no longer needed.",
        "To act now, use compress with a range covering these blocks.",
    ].join(" ")
}

export function runBatchCleanup(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): BatchCleanupResult {
    const noop: BatchCleanupResult = {
        tier: 0,
        action: "none",
        mergedCount: 0,
        savedTokens: 0,
    }

    if (!state.modelContextLimit || state.modelContextLimit <= 0) {
        return noop
    }

    const currentTokens = getCurrentTokenUsage(state, messages)
    const limit = state.modelContextLimit
    const batchCleanup = resolveBatchCleanup(config.gc)
    const maxMergedLength = config.gc.maxOldGenSummaryLength

    const forceTokens = percentToTokens(batchCleanup.forceThreshold, limit)
    const highTokens = percentToTokens(batchCleanup.highThreshold, limit)
    const lowTokens = percentToTokens(batchCleanup.lowThreshold, limit)

    if (currentTokens >= forceTokens) {
        const oldGenBlocks = collectActiveOldGenBlocks(state, maxMergedLength)
        if (oldGenBlocks.length < 2) {
            return noop
        }
        const ids = oldGenBlocks.map((b) => b.blockId)
        const result = mergeMarkedBlocks(state, ids, maxMergedLength)
        if (result.mergedCount === 0) {
            return noop
        }
        logger.info("Batch cleanup tier 3 (force): merged old-gen blocks", {
            mergedCount: result.mergedCount,
            savedTokens: result.savedTokens,
            currentTokens,
            forceThreshold: batchCleanup.forceThreshold,
        })
        return {
            tier: 3,
            action: "merge",
            mergedCount: result.mergedCount,
            savedTokens: result.savedTokens,
        }
    }

    if (currentTokens >= highTokens) {
        const marked = collectActiveMarkedBlocks(state)
        if (marked.length < 2) {
            return noop
        }
        const ids = marked.map((b) => b.blockId)
        const result = mergeMarkedBlocks(state, ids, maxMergedLength)
        if (result.mergedCount === 0) {
            return noop
        }
        logger.info("Batch cleanup tier 2 (high): merged marked blocks", {
            mergedCount: result.mergedCount,
            savedTokens: result.savedTokens,
            currentTokens,
            highThreshold: batchCleanup.highThreshold,
        })
        return {
            tier: 2,
            action: "merge",
            mergedCount: result.mergedCount,
            savedTokens: result.savedTokens,
        }
    }

    if (currentTokens >= lowTokens) {
        const nudgeText = buildNudgeText(state, maxMergedLength)
        if (!nudgeText) {
            return noop
        }
        logger.info("Batch cleanup tier 1 (low): nudge injected", {
            currentTokens,
            lowThreshold: batchCleanup.lowThreshold,
        })
        return {
            tier: 1,
            action: "nudge",
            mergedCount: 0,
            savedTokens: 0,
            nudgeText,
        }
    }

    return noop
}
