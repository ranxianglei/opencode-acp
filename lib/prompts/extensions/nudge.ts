import type { SessionState, CompressionBlock } from "../../state"
import type { GCConfig } from "../../config"

export interface BlockGuidanceContext {
    currentTokens?: number
    modelContextLimit?: number
    includeHint?: boolean
}

export function buildCompressedBlockGuidance(
    state: SessionState,
    gcConfig?: GCConfig,
    context?: BlockGuidanceContext,
): string {
    const activeBlockIds = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)

    const refs = activeBlockIds.map((id) => `b${id}`)
    const blockCount = refs.length
    let blockList: string
    if (blockCount <= 20) {
        blockList = blockCount > 0 ? refs.join(", ") : "none"
    } else {
        const recent = refs.slice(-20).join(", ")
        blockList = `${recent} (+${blockCount - 20} older, use decompress to access by ID)`
    }

    const includeHint = context?.includeHint ?? true

    const lines = [
        "Compressed block context:",
        `- Active compressed blocks: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ]

    if (includeHint) {
        lines.push("- 💡 When you've finished using tool outputs, compress them — you can decompress later if needed. Lean context improves accuracy.")
    }

    if (blockCount > 50) {
        const oldBlockIds = activeBlockIds.slice(0, Math.max(0, blockCount - 20))
        const oldBlocks = oldBlockIds
            .map((id) => state.prune.messages.blocksById.get(id))
            .filter((b): b is CompressionBlock => b !== undefined)

        if (oldBlocks.length > 5) {
            const totalTokens = oldBlocks.reduce((sum, b) => sum + (b.summaryTokens ?? 0), 0)
            const totalK = Math.max(1, Math.round(totalTokens / 1000))

            const targets: string[] = []
            const chunkSize = Math.ceil(oldBlocks.length / 3)
            for (let i = 0; i < 3 && i * chunkSize < oldBlocks.length; i++) {
                const chunk = oldBlocks.slice(i * chunkSize, (i + 1) * chunkSize)
                if (chunk.length < 2) continue
                const start = chunk[0].startId
                const end = chunk[chunk.length - 1].endId
                if (!start || !end) continue
                const chunkTokens = chunk.reduce((s, b) => s + (b.summaryTokens ?? 0), 0)
                const chunkK = Math.max(1, Math.round(chunkTokens / 1000))
                targets.push(`  • compress ${start}→${end}: ${chunk.length} blocks (~${chunkK}K tokens)`)
            }

            if (targets.length > 0) {
                lines.push(`- 🔀 ${oldBlocks.length} old blocks using ~${totalK}K tokens. Consolidate into ${targets.length}:`)
                lines.push(...targets)
                lines.push(`  Each summary ≤200 chars, include (bN) for consumed blocks. Cover full range in one compress call.`)
            }
        } else {
            lines.push(`- 🔀 You have ${blockCount} blocks — use compress to consolidate adjacent same-topic blocks.`)
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
