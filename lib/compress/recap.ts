import { tool } from "@opencode-ai/plugin"
import type { CompressionBlock } from "../state/types"
import type { ToolContext } from "./types"

function formatCoverage(block: CompressionBlock): string {
    const count = block.effectiveMessageIds?.length || 0
    return count > 0 ? `${count} message${count !== 1 ? "s" : ""}` : "—"
}

const RECAP_TOOL_DESCRIPTION = `Read-only retrieval of compression block summaries.

Call this tool to re-fetch a specific block's summary without decompressing the full original content. Useful when a past compress tool call's summary has scrolled out of context or was truncated by the provider.

Args:
- blockId: optional block number (e.g., 5). If omitted, lists all active blocks with brief info.`

export function createAcpContextRecapTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: RECAP_TOOL_DESCRIPTION,
        args: {
            blockId: tool.schema
                .number()
                .optional()
                .describe("Block number to retrieve (e.g., 5). If omitted, lists all active blocks."),
        },
        async execute(args) {
            const msgState = ctx.state.prune.messages
            const activeIds = Array.from(msgState.activeBlockIds).sort((a, b) => a - b)

            if (activeIds.length === 0) {
                return "No active compression blocks."
            }

            if (args.blockId !== undefined) {
                const block = msgState.blocksById.get(args.blockId)
                if (!block) {
                    return `Block b${args.blockId} not found. Active blocks: ${activeIds.map((id) => `b${id}`).join(", ")}`
                }
                if (!block.active) {
                    return `Block b${args.blockId} is inactive (deactivated by GC or nested compression).`
                }
                const range = formatCoverage(block)
                return `[Compressed conversation section]\n${block.summary}\n\n[Block b${args.blockId} | ${range} | topic: "${block.topic || "(none)"}"]`
            }

            const lines: string[] = []
            lines.push(`Active compression blocks (${activeIds.length}):`)
            for (const id of activeIds) {
                const block = msgState.blocksById.get(id)
                if (!block || !block.active) continue
                const range = formatCoverage(block)
                const summaryPreview = block.summary.slice(0, 200)
                lines.push(`\nb${id} | ${range} | "${block.topic || "(none)"}"`)
                lines.push(`  ${summaryPreview}${block.summary.length > 200 ? "..." : ""}`)
            }
            lines.push(`\nCall with blockId to get the full summary: acp_context_recap({ blockId: N })`)
            return lines.join("\n")
        },
    })
}
