import type { SessionState, CompressionBlock } from "../../state/types"
import type { PluginConfig } from "../../config/types"
import type { WithParts } from "../../state/types"
import type { Logger } from "../../infra/logger"
import { getActiveBlocks } from "../../state/queries"

const AGING_WARNING_THRESHOLD_PERCENT = 50

export function shouldShowAgingWarning(
    config: PluginConfig,
    state: SessionState,
): boolean {
    if (state.modelContextLimit === undefined || state.modelContextLimit <= 0) {
        return false
    }

    const usagePercent = (getCurrentTokenEstimate(state) / state.modelContextLimit) * 100
    return usagePercent >= AGING_WARNING_THRESHOLD_PERCENT
}

function getCurrentTokenEstimate(state: SessionState): number {
    return state.stats.pruneTokenCounter
}

export function renderAgingWarning(
    state: SessionState,
    logger?: { warn: (msg: string, ctx?: unknown) => void },
): string {
    const oldGenBlocks = getOldGenBlocks(state)
    const youngGenBlocks = getYoungGenBlocks(state)

    if (oldGenBlocks.length === 0 && youngGenBlocks.length === 0) {
        return ""
    }

    const lines: string[] = []

    if (oldGenBlocks.length > 0) {
        const blockIds = oldGenBlocks.map((b) => `b${b.blockId}`).join(", ")
        lines.push(
            `Old-generation blocks at risk of GC truncation: ${blockIds}. ` +
                `If these blocks contain details you still need, consider re-summarizing them into a fresh range before they are truncated.`,
        )
    }

    if (youngGenBlocks.length > 0 && youngGenBlocks.some((b) => b.survivedCount >= 3)) {
        const atRisk = youngGenBlocks.filter((b) => b.survivedCount >= 3)
        const blockIds = atRisk.map((b) => `b${b.blockId}`).join(", ")
        lines.push(
            `Blocks approaching old-generation promotion: ${blockIds}. ` +
                `These will soon be eligible for summary truncation.`,
        )
    }

    return lines.join("\n")
}

function getOldGenBlocks(state: SessionState): CompressionBlock[] {
    const result: CompressionBlock[] = []
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.active && block.generation === "old") {
            result.push(block)
        }
    }
    return result
}

function getYoungGenBlocks(state: SessionState): CompressionBlock[] {
    const result: CompressionBlock[] = []
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.active && block.generation !== "old") {
            result.push(block)
        }
    }
    return result
}

export function renderPriorityGuidance(
    config: PluginConfig,
    messages: WithParts[],
): string {
    const protectedTools = new Set(config.compress.protectedTools)
    const hasProtectedContent = messages.some((msg) =>
        msg.parts.some(
            (part) => part.type === "tool" && protectedTools.has((part as { tool: string }).tool),
        ),
    )

    if (!hasProtectedContent) {
        return ""
    }

    return `Priority guidance: Messages containing protected tool calls (${[...protectedTools].join(", ")}) are marked BLOCKED and will never be compressed. Prioritize compressing other content first.`
}
