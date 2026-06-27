import type { SessionState, CompressionBlock } from "../state/types"
import type { PluginConfig, GCConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export interface CompactionResult {
    compactedBlocks: number
    savedTokens: number
}

export interface GCParams {
    maxOldGenSummaryLength: number
    modelContextLimit: number
    currentTokens: number
}

export function runTruncateGC(
    blocks: CompressionBlock[],
    params: GCParams,
): CompactionResult {
    let compactedBlocks = 0
    let savedTokens = 0

    for (const block of blocks) {
        if (!block.active) continue
        if (block.summary.length <= params.maxOldGenSummaryLength) continue

        const originalLength = block.summary.length
        const truncated = truncateSummary(block.summary, params.maxOldGenSummaryLength, block.blockId)
        const savedChars = originalLength - truncated.length
        if (savedChars > 0) {
            block.summary = truncated
            block.summaryTokens = Math.round(truncated.length / 4)
            compactedBlocks++
            savedTokens += Math.round(savedChars / 4)
        }
    }

    return { compactedBlocks, savedTokens }
}

function truncateSummary(summary: string, maxLength: number, _blockId: number): string {
    if (summary.length <= maxLength) return summary

    const headerEnd = summary.indexOf("\n")
    if (headerEnd === -1) return summary.slice(0, maxLength) + "\n...\n[GC truncated]"

    const header = summary.slice(0, headerEnd + 1)
    const footerStart = summary.lastIndexOf("\n\n")
    const footer = footerStart > headerEnd ? summary.slice(footerStart) : ""

    const availableForContent = maxLength - header.length - footer.length - 20
    if (availableForContent < 100) {
        return header + "...\n[GC truncated]" + footer
    }

    const content = summary.slice(headerEnd + 1, headerEnd + 1 + availableForContent)
    return header + content + "\n...\n[GC truncated]" + footer
}

export function shouldRunMajorGC(
    currentTokens: number,
    modelContextLimit: number | undefined,
    gcConfig: GCConfig,
): boolean {
    if (!modelContextLimit || modelContextLimit === 0) return false

    const threshold = parseGcThreshold(gcConfig.majorGcThresholdPercent, modelContextLimit)
    return currentTokens >= threshold
}

export function getGCParams(
    gcConfig: GCConfig,
    modelContextLimit: number,
    currentTokens: number,
): GCParams {
    return {
        maxOldGenSummaryLength: gcConfig.maxOldGenSummaryLength,
        modelContextLimit,
        currentTokens,
    }
}

function parseGcThreshold(limit: number | `${number}%` | string, modelContextLimit: number): number {
    if (typeof limit === "number") return limit
    const percent = parseFloat(limit.slice(0, -1))
    if (isNaN(percent)) return modelContextLimit
    return Math.round((Math.max(0, Math.min(100, Math.round(percent))) / 100) * modelContextLimit)
}

export function runMajorGC(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
): void {
    const threshold = config.gc.majorGcThresholdPercent
    if (threshold === "100%" && state.modelContextLimit === undefined) {
        ageAndDeactivate(state, config, logger)
        return
    }

    ageAndDeactivate(state, config, logger)
    truncateOldGenSummaries(state, config, logger)
}

function ageAndDeactivate(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
): void {
    const { promotionThreshold, maxBlockAge } = config.gc
    const messages = state.prune.messages

    for (const block of messages.blocksById.values()) {
        if (!block.active) continue

        block.survivedCount++

        if (block.generation !== "old" && block.survivedCount >= promotionThreshold) {
            block.generation = "old"
            logger.debug("Block promoted to old generation", { blockId: block.blockId })
        }

        if (block.survivedCount >= maxBlockAge) {
            deactivateBlock(state, block, logger)
        }
    }

    reconcileActiveSets(state)
}

function deactivateBlock(
    state: SessionState,
    block: CompressionBlock,
    logger: Logger,
): void {
    block.active = false
    block.deactivatedAt = Date.now()
    logger.debug("Block deactivated by GC (age)", { blockId: block.blockId })
}

function truncateOldGenSummaries(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
): void {
    const maxLength = config.gc.maxOldGenSummaryLength

    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.active) continue
        if (block.generation !== "old") continue
        if (block.summary.length <= maxLength) continue

        const truncated = block.summary.slice(0, maxLength)
        logger.info("Truncated old-gen summary", {
            blockId: block.blockId,
            originalLength: block.summary.length,
            truncatedLength: truncated.length,
        })
        block.summary = truncated
    }
}

function reconcileActiveSets(state: SessionState): void {
    const messages = state.prune.messages
    messages.activeBlockIds.clear()
    messages.activeByAnchorMessageId.clear()

    for (const block of messages.blocksById.values()) {
        if (!block.active) continue

        messages.activeBlockIds.add(block.blockId)

        if (block.anchorMessageId) {
            messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
        }
    }

    for (const [msgId, entry] of messages.byMessageId) {
        entry.activeBlockIds = entry.allBlockIds.filter((id) =>
            messages.activeBlockIds.has(id),
        )
    }
}
