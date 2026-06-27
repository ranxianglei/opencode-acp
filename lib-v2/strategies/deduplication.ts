import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

interface ToolCallKey {
    callID: string
    tool: string
    inputHash: string
}

function hashInput(input: unknown): string {
    try {
        return JSON.stringify(input ?? {})
    } catch {
        return String(input)
    }
}

export function deduplicate(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): number {
    if (!config.strategies.deduplication.enabled) return 0

    const protectedTools = new Set(config.strategies.deduplication.protectedTools)
    const seen = new Map<string, string>()

    let prunedCount = 0

    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue

            const toolPart = part as { type: "tool"; tool: string; callID: string; state: { input?: unknown } }
            if (protectedTools.has(toolPart.tool)) continue

            const inputHash = hashInput(toolPart.state.input)
            const key = `${toolPart.tool}:${inputHash}`

            const existingCallId = seen.get(key)
            if (existingCallId) {
                state.prune.tools.set(existingCallId, 1)
                prunedCount++
                logger.debug("Marked duplicate tool call for pruning", {
                    tool: toolPart.tool,
                    originalCallId: existingCallId,
                    newCallId: toolPart.callID,
                })
            }

            seen.set(key, toolPart.callID)
        }
    }

    return prunedCount
}
