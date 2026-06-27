import type { CommandContext, CommandResult } from "./types"
import { formatTokenCount } from "../ui/utils"

export function statsCommand(ctx: CommandContext): CommandResult {
    const { state } = ctx
    const messages = state.prune.messages
    const allBlocks = Array.from(messages.blocksById.values())
    const activeBlocks = allBlocks.filter((b) => b.active)
    const inactiveBlocks = allBlocks.filter((b) => !b.active)
    const youngBlocks = activeBlocks.filter((b) => b.generation === "young")
    const oldBlocks = activeBlocks.filter((b) => b.generation === "old")
    const totalTokensSaved = allBlocks.reduce((sum, b) => sum + b.compressedTokens, 0)

    const lines: string[] = [
        "**ACP compression statistics**",
        "",
        `Total blocks: ${allBlocks.length}`,
        `- Active: ${activeBlocks.length} (young: ${youngBlocks.length}, old: ${oldBlocks.length})`,
        `- Inactive: ${inactiveBlocks.length}`,
        `- Total tokens saved: ${formatTokenCount(totalTokensSaved)}`,
        "",
    ]

    if (activeBlocks.length === 0) {
        lines.push("No active compression blocks.")
        return { output: lines.join("\n") }
    }

    const sorted = [...activeBlocks].sort((a, b) => a.blockId - b.blockId)
    lines.push("**Active blocks** (block id | tokens saved | survival count | generation | topic)")
    for (const block of sorted) {
        const gen = block.generation ?? "young"
        const topic = block.topic || "untitled"
        lines.push(
            `- b${block.blockId}: ${formatTokenCount(block.compressedTokens)} | ${block.survivedCount} | ${gen} | ${topic}`,
        )
    }

    return { output: lines.join("\n") }
}
