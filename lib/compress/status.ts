import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { formatAge } from "../ui/utils"
import type { CompressionBlock } from "../state/types"

const ACP_STATUS_TOOL_DESCRIPTION = `Show detailed status of all active compressed context blocks. Returns block IDs, sizes, ages, topics, and the message-ID ranges each block consumed — use this to see what has been compressed away and to choose safe compress boundaries.

Use this tool when:
- You are unsure which mNNNNN refs are still compressible
- Before choosing compress boundaries, if any prior compressions exist
- You want to see block sizes before deciding to decompress
- A compress call failed with "not available" (the ID was likely consumed)

Args:
- mode: "summary" (default) — one line per block with size/range/topic. "detailed" — adds age, generation, effective message count, consumed block lineage.
- sort: "recent" (default) | "size" (largest compressed first) | "age" (oldest surviving first, nearing GC).
- limit: max blocks to show (default 30).`

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function formatSizePair(compressed: number, summary: number): string {
    return `${formatTokens(compressed)}→${formatTokens(summary)}`
}

function formatIdRange(block: CompressionBlock): string {
    const start = (block.startId || "").trim()
    const end = (block.endId || "").trim()
    if (!start || !end) return "—"
    if (start === end) return start
    return `${start}–${end}`
}

function sortBlocks(
    blocks: CompressionBlock[],
    sort: "recent" | "size" | "age",
): CompressionBlock[] {
    const copy = [...blocks]
    if (sort === "size") {
        copy.sort((a, b) => (b.compressedTokens || 0) - (a.compressedTokens || 0))
    } else if (sort === "age") {
        copy.sort((a, b) => (b.survivedCount || 0) - (a.survivedCount || 0))
    } else {
        copy.sort((a, b) => b.createdAt - a.createdAt)
    }
    return copy
}

function renderSummaryRow(block: CompressionBlock, idWidth: number): string {
    const idStr = `b${block.blockId}`.padEnd(idWidth + 1)
    const sizeStr = formatSizePair(block.compressedTokens, block.summaryTokens).padStart(13)
    const ageStr = formatAge(block.createdAt).padStart(10)
    const rangeStr = formatIdRange(block).padStart(19)
    const topic = block.topic || "(no topic)"
    return `  ${idStr} ${sizeStr}  ${ageStr}  ${rangeStr}   "${topic}"`
}

function renderDetailedRow(block: CompressionBlock, idWidth: number): string {
    const idStr = `b${block.blockId}`.padEnd(idWidth + 1)
    const sizeStr = formatSizePair(block.compressedTokens, block.summaryTokens).padStart(13)
    const ageStr = formatAge(block.createdAt).padStart(10)
    const rangeStr = formatIdRange(block).padStart(19)
    const survived = block.survivedCount ?? 0
    const gen = block.generation ?? "young"
    const effCount = block.effectiveMessageIds?.length ?? 0
    const consumedLineage =
        block.consumedBlockIds && block.consumedBlockIds.length > 0
            ? ` nested=[${block.consumedBlockIds.map((n) => `b${n}`).join(",")}]`
            : ""
    const topic = block.topic || "(no topic)"
    return `  ${idStr} ${sizeStr}  ${ageStr}  ${rangeStr}  age=${survived} ${gen} eff=${effCount}${consumedLineage}  "${topic}"`
}

export function createAcpStatusTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: ACP_STATUS_TOOL_DESCRIPTION,
        args: {
            mode: tool.schema
                .string()
                .optional()
                .describe('Output detail level: "summary" (default) or "detailed"'),
            sort: tool.schema
                .string()
                .optional()
                .describe('Sort order: "recent" (default), "size", or "age"'),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum blocks to show (default 30)"),
        },
        async execute(args) {
            const mode = args.mode === "detailed" ? "detailed" : "summary"
            const sort: "recent" | "size" | "age" =
                args.sort === "size" || args.sort === "age" ? args.sort : "recent"
            const limit = Number.isFinite(args.limit) && args.limit! > 0 ? Math.min(args.limit!, 200) : 30

            const messages = ctx.state.prune.messages
            const activeIds = Array.from(messages.activeBlockIds).sort((a, b) => a - b)

            if (activeIds.length === 0) {
                return "No compressed blocks. Context is fully visible."
            }

            const allBlocks = activeIds
                .map((id) => messages.blocksById.get(id))
                .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

            if (allBlocks.length === 0) {
                return "No compressed blocks. Context is fully visible."
            }

            const totalSummary = allBlocks.reduce((s, b) => s + (b.summaryTokens || 0), 0)
            const totalCompressed = allBlocks.reduce((s, b) => s + (b.compressedTokens || 0), 0)
            const sorted = sortBlocks(allBlocks, sort)
            const shown = sorted.slice(0, limit)
            const truncated = sorted.length - shown.length

            const idWidth = Math.max(...shown.map((b) => String(b.blockId).length))

            const lines: string[] = [
                `ACP Status — ${allBlocks.length} active compressed block${allBlocks.length === 1 ? "" : "s"} (${formatTokens(totalSummary)} summary, ${formatTokens(totalCompressed)} original compressed)`,
                "",
            ]

            for (const b of shown) {
                lines.push(
                    mode === "detailed" ? renderDetailedRow(b, idWidth) : renderSummaryRow(b, idWidth),
                )
            }

            if (truncated > 0) {
                lines.push("")
                lines.push(`${shown.length} of ${sorted.length} blocks shown (${truncated} hidden). Raise limit or change sort to see more.`)
            }

            lines.push("")
            const sortHint =
                sort === "recent"
                    ? 'sorted by recent. Use acp_status({sort:"size"}) for largest, {sort:"age"} for near-GC.'
                    : `sorted by ${sort}.`
            lines.push(`${sortHint} Use decompress to restore a block's full content, or search_context to search within compressed blocks.`)

            return lines.join("\n")
        },
    })
}
