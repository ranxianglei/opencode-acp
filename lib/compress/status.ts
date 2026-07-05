import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { formatAge } from "../ui/utils"

const ACP_STATUS_TOOL_DESCRIPTION = `Show detailed status of all active compressed context blocks. Returns a table of block IDs, summary sizes, ages, and topics — use this to decide which blocks to decompress or search. No arguments needed.

Use this tool when:
- You need to know what content has been compressed away
- You want to see block sizes before deciding to decompress
- You need a quick overview of context compression state`

function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

export function createAcpStatusTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: ACP_STATUS_TOOL_DESCRIPTION,
        args: {},
        async execute() {
            const messages = ctx.state.prune.messages
            const activeIds = Array.from(messages.activeBlockIds).sort((a, b) => a - b)

            if (activeIds.length === 0) {
                return "No compressed blocks. Context is fully visible."
            }

            const blocks = activeIds
                .map((id) => messages.blocksById.get(id))
                .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

            const totalSummary = blocks.reduce((sum, b) => sum + b.summaryTokens, 0)
            const totalCompressed = blocks.reduce((sum, b) => sum + b.compressedTokens, 0)

            const lines: string[] = [
                `ACP Status — ${blocks.length} active compressed block${blocks.length === 1 ? "" : "s"} (${formatTokens(totalSummary)} summary tokens, ${formatTokens(totalCompressed)} original content compressed)`,
                "",
            ]

            const idWidth = String(Math.max(...activeIds)).length
            for (const b of blocks) {
                const idStr = `b${b.blockId}`.padEnd(idWidth + 1)
                const tokStr = `${formatTokens(b.summaryTokens)}t`.padStart(7)
                const ageStr = formatAge(b.createdAt).padStart(10)
                const topic = b.topic || "(no topic)"
                lines.push(`  ${idStr} ${tokStr}  ${ageStr}   "${topic}"`)
            }

            lines.push("")
            lines.push(
                "Use decompress to restore a block's full content, or search_context to search within compressed blocks.",
            )

            return lines.join("\n")
        },
    })
}
