import type { SessionState, CompressionBlock } from "../../state"
import type { GCConfig } from "../../config"
import { formatAge as formatBlockAge } from "../../ui/utils"

export interface BlockGuidanceContext {
    currentTokens?: number
    modelContextLimit?: number
    includeHint?: boolean
    /**
     * Raw message IDs currently visible in the model's context window.
     * When provided, the directive nudge only suggests ranges whose anchor
     * messages are still visible, preventing stale-ID and backwards-range bugs.
     */
    visibleMessageIds?: Set<string>
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

    const blocksForStats = activeBlockIds
        .map((id) => state.prune.messages.blocksById.get(id))
        .filter((b): b is CompressionBlock => b !== undefined && b.active)
    const totalSummaryTokens = blocksForStats.reduce((s, b) => s + (b.summaryTokens ?? 0), 0)
    const totalSummaryDisplay =
        totalSummaryTokens >= 1000
            ? `${(totalSummaryTokens / 1000).toFixed(1)}K`
            : String(totalSummaryTokens)
    const lastBlock = blocksForStats.length > 0
        ? blocksForStats.reduce((latest, b) => (b.createdAt > latest.createdAt ? b : latest))
        : null
    const ageStr = lastBlock ? formatBlockAge(lastBlock.createdAt) : "never"

    const lines = [
        `- Compressed blocks: ${blockCount} (${totalSummaryDisplay} summary, last ${ageStr}). Use acp_status for details.`,
    ]

    if (blockCount > 50) {
        const oldBlockIds = activeBlockIds.slice(0, Math.max(0, blockCount - 20))
        const allOldBlocks = oldBlockIds
            .map((id) => state.prune.messages.blocksById.get(id))
            .filter((b): b is CompressionBlock => b !== undefined)

        // [Plan B] Filter to blocks whose anchor message is still visible, then
        // build suggestion ranges from anchor refs (mNNNNN) instead of stored
        // block startId/endId. This avoids suggesting IDs that are no longer
        // visible and prevents backwards ranges (end < start).
        const visibleMessageIds = context?.visibleMessageIds
        const visibleOldBlocks =
            visibleMessageIds === undefined
                ? allOldBlocks
                : allOldBlocks.filter((b) => b.anchorMessageId && visibleMessageIds.has(b.anchorMessageId))

        if (visibleOldBlocks.length > 5) {
            const blocksWithRef = visibleOldBlocks
                .map((block) => {
                    const ref = state.messageIds.byRawId.get(block.anchorMessageId)
                    return ref ? { block, ref } : null
                })
                .filter((x): x is { block: CompressionBlock; ref: string } => x !== null)
                .sort((a, b) => a.ref.localeCompare(b.ref))

            const totalTokens = blocksWithRef.reduce((s, x) => s + (x.block.summaryTokens ?? 0), 0)
            const totalK = Math.max(1, Math.round(totalTokens / 1000))

            const targets: string[] = []
            const chunkSize = Math.ceil(blocksWithRef.length / 3)
            for (let i = 0; i < 3 && i * chunkSize < blocksWithRef.length; i++) {
                const chunk = blocksWithRef.slice(i * chunkSize, (i + 1) * chunkSize)
                if (chunk.length < 2) continue
                // Sorted by ref above guarantees startRef <= endRef.
                const startRef = chunk[0].ref
                const endRef = chunk[chunk.length - 1].ref
                const chunkTokens = chunk.reduce((s, x) => s + (x.block.summaryTokens ?? 0), 0)
                const chunkK = Math.max(1, Math.round(chunkTokens / 1000))
                targets.push(`  • compress ${startRef}→${endRef}: ${chunk.length} blocks (~${chunkK}K tokens)`)
            }

            if (targets.length > 0) {
                lines.push(`- 🔀 ${blocksWithRef.length} old blocks using ~${totalK}K tokens. Consolidate into ${targets.length}:`)
                lines.push(...targets)
                lines.push(`  System auto-detects blocks in range — no need to manually list (bN) placeholders. Just write a short prose summary.`)
            }
        }
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
