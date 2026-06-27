import type { CommandContext, CommandResult } from "./types"
import { getActiveBlocks } from "../state/queries"
import { formatTokenCount } from "../ui/utils"

export function sweepCommand(ctx: CommandContext): CommandResult {
    const { state, logger } = ctx

    const activeBlocks = getActiveBlocks(state)
    const tokensAlreadyCompacted = activeBlocks.reduce((sum, b) => sum + b.compressedTokens, 0)

    state.pendingManualTrigger = {
        sessionId: state.sessionId ?? "",
        prompt: "Sweep: compress all older, low-priority content not already covered by an active block.",
    }

    logger.info("sweep triggered", {
        activeBlocks: activeBlocks.length,
        sessionId: state.sessionId,
    })

    const lines: string[] = [
        "**Sweep scheduled**",
        "",
        "A full context sweep will run on the next message-transform pass.",
        "The model will be nudged to compress older, low-priority content.",
        "",
        `Active blocks before sweep: ${activeBlocks.length}`,
        `Tokens already compacted: ${formatTokenCount(tokensAlreadyCompacted)}`,
    ]

    return { output: lines.join("\n") }
}
