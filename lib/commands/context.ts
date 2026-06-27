import type { CommandContext, CommandResult } from "./types"
import { getActiveBlocks } from "../state/queries"
import { formatTokenCount } from "../ui/utils"

export function contextCommand(ctx: CommandContext): CommandResult {
    const { state } = ctx
    const lines: string[] = ["**ACP context**", ""]

    const limit = state.modelContextLimit
    if (limit !== undefined && limit > 0) {
        lines.push(`- Model context limit: ${formatTokenCount(limit)}`)
    } else {
        lines.push("- Model context limit: unknown")
    }

    const activeBlocks = getActiveBlocks(state)
    const savedByActive = activeBlocks.reduce((sum, b) => sum + b.compressedTokens, 0)
    lines.push(`- Active compression blocks: ${activeBlocks.length}`)
    lines.push(`- Tokens freed by active blocks: ${formatTokenCount(savedByActive)}`)

    const totalSaved = state.stats.totalPruneTokens
    lines.push(`- Tokens freed cumulatively: ${formatTokenCount(totalSaved)}`)

    lines.push(`- Current turn: ${state.currentTurn}`)

    if (state.lastCompaction > 0) {
        lines.push(`- Last compaction reset: ${new Date(state.lastCompaction).toISOString()}`)
    }

    return { output: lines.join("\n") }
}
