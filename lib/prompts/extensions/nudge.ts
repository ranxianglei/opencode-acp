import type { SessionState, CompressionBlock } from "../../state"
import type { GCConfig } from "../../config"

export interface BlockGuidanceContext {
    currentTokens?: number
    modelContextLimit?: number
    includeHint?: boolean
}

const MERGE_NUDGE_THRESHOLD = 50

function summarizeTokensForBlock(block: CompressionBlock): number {
    return block.summaryTokens || Math.round(block.summary.length / 4)
}

function quoteTopic(topic: string | undefined): string {
    const trimmed = (topic || "").replace(/\s+/g, " ").trim()
    return `"${trimmed.length > 0 ? trimmed : "(no topic)"}"`
}

export function buildCompressedBlockGuidance(
    state: SessionState,
    gcConfig?: GCConfig,
    context?: BlockGuidanceContext,
): string {
    const activeBlockIds = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)

    const blockCount = activeBlockIds.length
    let blockList: string
    let savingsSuffix = ""

    if (blockCount <= 20) {
        if (blockCount === 0) {
            blockList = "none"
        } else {
            const entries = activeBlockIds.map((id) => {
                const block = state.prune.messages.blocksById.get(id)
                return `b${id}: ${quoteTopic(block?.topic)}`
            })
            blockList = entries.join(", ")
        }
    } else {
        const recentIds = activeBlockIds.slice(-20)
        const recentFirst = recentIds[0]!
        const recentLast = recentIds[recentIds.length - 1]!
        const olderCount = blockCount - recentIds.length
        const recentRange =
            recentIds.length > 1 && recentLast - recentFirst === recentIds.length - 1
                ? `b${recentFirst}-b${recentLast}`
                : recentIds.map((id) => `b${id}`).join(", ")
        const olderLabel = olderCount > 0 ? ` + ${olderCount} older` : ""
        blockList = `${recentRange}${olderLabel}`

        let totalTokens = 0
        for (const id of activeBlockIds) {
            const block = state.prune.messages.blocksById.get(id)
            if (block) {
                totalTokens += summarizeTokensForBlock(block)
            }
        }
        const totalK = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1).replace(".0", "")}K` : `${totalTokens}`
        savingsSuffix = `. Total: ~${totalK} tokens compressed`
    }

    const includeHint = context?.includeHint ?? true

    const lines = [
        "Compressed block context:",
        `- Active compressed blocks: ${blockCount} (${blockList}${savingsSuffix})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ]

    if (includeHint) {
        lines.push("- 💡 When you've finished using tool outputs, compress them — you can decompress later if needed. Lean context improves accuracy.")
    }

    if (blockCount > MERGE_NUDGE_THRESHOLD) {
        lines.push(
            `- 🔀 You have ${blockCount} blocks — use the merge_blocks tool to merge adjacent same-topic blocks. Example: merge_blocks with blockIds "${activeBlockIds[0]}-${activeBlockIds[1]}".`,
        )
    }

    // [FIX Bug 35] Only show aging warnings when context usage is above 50%.
    // Showing warnings at low usage causes unnecessary compress operations that
    // waste tokens and attention — the model preemptively re-summarizes blocks
    // that aren't actually at risk of GC truncation.
    const usageRatio =
        context?.currentTokens && context?.modelContextLimit
            ? context.currentTokens / context.modelContextLimit
            : 0

    if (gcConfig && usageRatio > 0.5) {
        const promotionThreshold = gcConfig.promotionThreshold
        const agingBlocks: string[] = []

        for (const blockId of activeBlockIds) {
            const block = state.prune.messages.blocksById.get(blockId)
            if (!block) continue

            const survived = block.survivedCount ?? 0
            const gen = block.generation ?? "young"
            const sizeK = (block.summary.length / 1000).toFixed(1)
            const preview = block.summary.slice(0, 120).replace(/\n/g, " ")

            if (gen === "old" || survived >= promotionThreshold - 2) {
                agingBlocks.push(
                    `  b${blockId}: age=${survived}/${promotionThreshold}, gen=${gen}, size=${sizeK}K chars — ${preview}...`,
                )
            }
        }

        if (agingBlocks.length > 0) {
            lines.push("")
            lines.push("⚠️ Block aging warning — these blocks may be truncated by GC soon:")
            lines.push(...agingBlocks)
            lines.push(
                "To preserve important content: use the compress tool to re-summarize these blocks into new concise ones. Unhandled blocks will be auto-truncated.",
            )
        }
    }

    return lines.join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
