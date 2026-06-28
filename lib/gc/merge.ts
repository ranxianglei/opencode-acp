import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { BatchCleanupConfig, GCConfig, PluginConfig } from "../config"
import type { Logger } from "../logger"
import { countTokens, getCurrentTokenUsage } from "../token-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    wrapCompressedSummary,
} from "../compress/state"
import { formatBlockRef } from "../message-ids"

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

const DEFAULT_BATCH_CLEANUP: BatchCleanupConfig = {
    lowThreshold: "55%",
    highThreshold: "75%",
    forceThreshold: "90%",
}

/** Minimum marked-block count to trigger escalation nudge (tier 2 active compress). */
const ESCALATE_MIN_MARKED = 3

/** Minimum marked/old-gen ratio to trigger escalation nudge. */
const ESCALATE_MIN_RATIO = 0.4

function resolveBatchCleanup(gc: GCConfig): BatchCleanupConfig {
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

function collectActiveOldGenBlocks(state: SessionState, maxOldGenSummaryLength: number): CompressionBlock[] {
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
    const messagesState = state.prune.messages
    const ids = Array.from(messagesState.markedForCleanup).sort((a, b) => a - b)
    const blocks: CompressionBlock[] = []
    for (const id of ids) {
        const block = messagesState.blocksById.get(id)
        if (!block || !block.active) {
            messagesState.markedForCleanup.delete(id)
            continue
        }
        blocks.push(block)
    }
    return blocks
}

function extractSummaryBody(summary: string): string {
    let body = summary
    const headerPrefix = COMPRESSED_BLOCK_HEADER + "\n"
    if (body.startsWith(headerPrefix)) {
        body = body.slice(headerPrefix.length)
    }
    body = body.replace(/\n<dcp-message-id[^>]*>b\d+<\/dcp-message-id>$/, "")
    return body.trim()
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
    const newBlockId = allocateBlockId(state)
    const newRunId = allocateRunId(state)

    const bodies = sourceBlocks.map((block) => extractSummaryBody(block.summary))
    const mergedRaw = bodies.join("\n---\n")
    const mergedBody = truncateMergedSummary(mergedRaw, maxMergedLength)
    const newSummary = wrapCompressedSummary(newBlockId, mergedBody)
    const newSummaryTokens = countTokens(newSummary)

    const oldest = sourceBlocks[0]
    const newest = sourceBlocks[sourceBlocks.length - 1]

    const effectiveMessageIds = new Set<string>()
    const effectiveToolIds = new Set<string>()
    for (const block of sourceBlocks) {
        for (const id of block.effectiveMessageIds) effectiveMessageIds.add(id)
        for (const id of block.effectiveToolIds) effectiveToolIds.add(id)
    }

    const sourceIds = sourceBlocks.map((b) => b.blockId)
    const createdAt = Date.now()

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
        createdAt,
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

function estimateTokens(blocks: CompressionBlock[]): number {
    return blocks.reduce(
        (sum, block) => sum + (block.summaryTokens || Math.round(block.summary.length / 4)),
        0,
    )
}

function buildNudgeText(state: SessionState, maxMergedLength: number): string | undefined {
    const marked = collectActiveMarkedBlocks(state)
    const oldGen = collectActiveOldGenBlocks(state, maxMergedLength)

    if (oldGen.length === 0) return undefined

    const oldGenIds = new Set(oldGen.map((b) => b.blockId))
    const markedOldGen = marked.filter((b) => oldGenIds.has(b.blockId))
    const markedOldGenCount = markedOldGen.length
    const oldGenCount = oldGen.length
    const ratio = markedOldGenCount / oldGenCount
    const ratioPct = Math.round(ratio * 100)
    const escalateMinPct = Math.round(ESCALATE_MIN_RATIO * 100)

    // Escalation: enough old-gen blocks marked → urge active compress now
    if (markedOldGenCount >= ESCALATE_MIN_MARKED && ratio >= ESCALATE_MIN_RATIO) {
        const refs = marked.map((b) => formatBlockRef(b.blockId)).join(", ")
        const firstRef = formatBlockRef(marked[0].blockId)
        const lastRef = formatBlockRef(marked[marked.length - 1].blockId)
        const estimatedSavings = Math.max(0, estimateTokens(marked) - Math.round(maxMergedLength / 4))

        return [
            `🔥 ${markedOldGenCount}/${oldGenCount} old-gen blocks marked (${ratioPct}%) — ready for batch cleanup.`,
            `Compressing ${refs} (range ${firstRef}–${lastRef}) would free ~${estimatedSavings} tokens in one cache break.`,
            `Call compress with this range now to consolidate them.`,
        ].join(" ")
    }

    // Some marks, not enough to escalate → keep marking
    if (marked.length >= 1) {
        const refs = marked.map((b) => formatBlockRef(b.blockId)).join(", ")
        const estimatedSavings = Math.max(0, estimateTokens(marked) - Math.round(maxMergedLength / 4))

        return [
            `⚠️ ${marked.length} block(s) marked for batch cleanup (${refs}).`,
            `Merge-compressing them would free ~${estimatedSavings} tokens.`,
            marked.length >= 2
                ? "They will auto-merge when context pressure reaches the high threshold."
                : "A single marked block won't auto-merge on its own — use compress to consolidate it, or unmark_block if no longer needed.",
            `Mark more old-gen blocks (need ≥${ESCALATE_MIN_MARKED} at ≥${escalateMinPct}%) to trigger batch cleanup sooner.`,
            "To act now, use compress with a range covering these blocks.",
        ].join(" ")
    }

    // No marks yet → guide the model to start marking (fixes chicken-and-egg deadlock)
    const shown = oldGen.slice(0, 5)
    const oldGenRefs = shown.map((b) => formatBlockRef(b.blockId)).join(", ")
    const more = oldGenCount > 5 ? ` (+${oldGenCount - 5} more)` : ""

    return [
        `📋 Context pressure rising — ${oldGenCount} old-gen compressed block(s) occupy ~${estimateTokens(oldGen)} tokens (${oldGenRefs}${more}).`,
        `Review which blocks contain information you no longer need, and use mark_block to flag them.`,
        `Once enough are marked (≥${ESCALATE_MIN_MARKED} at ≥${escalateMinPct}% of old-gen), they'll be batch-merged in one cache break to preserve cache hit rate.`,
        `Do NOT mark blocks you may still need.`,
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
        if (marked.length >= 2) {
            const ids = marked.map((b) => b.blockId)
            const result = mergeMarkedBlocks(state, ids, maxMergedLength)
            if (result.mergedCount > 0) {
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
        }
        // Not enough marks or merge produced nothing — fall through to nudge
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
