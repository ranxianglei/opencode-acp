import type { SessionState, CompressionBlock } from "../../state"
import type { GCConfig } from "../../config"

export function buildCompressedBlockGuidance(state: SessionState, gcConfig?: GCConfig): string {
    const activeBlockIds = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)

    const refs = activeBlockIds.map((id) => `b${id}`)
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    const lines = [
        "Compressed block context:",
        `- Active compressed blocks: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ]

    if (gcConfig) {
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
