import type { CompressionBlock } from "../state"
import type { GCConfig } from "../config"

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

export function getGCParams(gcConfig: GCConfig, modelContextLimit: number, currentTokens: number): GCParams {
    return {
        maxOldGenSummaryLength: gcConfig.maxOldGenSummaryLength,
        modelContextLimit,
        currentTokens,
    }
}

function parseGcThreshold(limit: number | `${number}%`, modelContextLimit: number): number {
    if (typeof limit === "number") return limit
    const percent = parseFloat(limit.slice(0, -1))
    if (isNaN(percent)) return modelContextLimit
    return Math.round((Math.max(0, Math.min(100, Math.round(percent))) / 100) * modelContextLimit)
}
