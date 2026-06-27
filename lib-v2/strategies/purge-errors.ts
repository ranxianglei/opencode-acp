import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export function purgeErrors(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): number {
    if (!config.strategies.purgeErrors.enabled) return 0

    const protectedTools = new Set(config.strategies.purgeErrors.protectedTools)
    const turnThreshold = config.strategies.purgeErrors.turns
    const currentTurn = state.currentTurn

    let prunedCount = 0

    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue

            const toolPart = part as {
                type: "tool"
                tool: string
                callID: string
                state: { status: string }
            }

            if (toolPart.state.status !== "error") continue
            if (protectedTools.has(toolPart.tool)) continue

            const msgTurn = (msg.info as { time?: { created?: number } }).time?.created ?? 0
            const turnsAgo = currentTurn - msgTurn
            if (turnsAgo < turnThreshold) continue

            state.prune.tools.set(toolPart.callID, 1)
            prunedCount++
            logger.debug("Marked errored tool input for pruning", {
                tool: toolPart.tool,
                callID: toolPart.callID,
                turnsAgo,
            })
        }
    }

    return prunedCount
}
