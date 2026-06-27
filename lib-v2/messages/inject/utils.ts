import type { PluginConfig } from "../../config/types"
import type { SessionState, WithParts, CompressionBlock } from "../../state/types"
import { countTokensSync } from "../../infra/token-counter"
import { getActiveBlocks } from "../../state/queries"

export { computeInputBudget } from "../utils"

export function computeContextUsage(
    state: SessionState,
    messages: WithParts[],
): number {
    const limit = state.modelContextLimit
    if (!limit || limit <= 0) return 0
    const used = estimateMessagesTokens(messages)
    if (used <= 0) return 0
    return Math.min(100, Math.round((used / limit) * 100))
}

export function getMessagesSinceLastUser(messages: WithParts[]): number {
    if (!Array.isArray(messages)) return 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg && msg.info && msg.info.role === "user") {
            return messages.length - 1 - i
        }
    }
    return messages.length
}

// Bug 35: aging warning must only show above 50% usage AND only when an
// old-gen block is past the halfway point of its lifetime; otherwise it fired
// at 20-30% usage and triggered premature compression.
export function shouldShowBlockAgingWarning(
    state: SessionState,
    config: PluginConfig,
    contextUsagePercent: number,
): boolean {
    if (contextUsagePercent <= 50) return false
    const maxBlockAge = config.gc.maxBlockAge
    if (typeof maxBlockAge !== "number" || maxBlockAge <= 0) return false
    const agingThreshold = Math.floor(maxBlockAge / 2)
    const active = getActiveBlocks(state)
    for (const block of active) {
        if (isApproachingMaxAge(block, agingThreshold)) return true
    }
    return false
}

function isApproachingMaxAge(
    block: CompressionBlock,
    agingThreshold: number,
): boolean {
    if (block.generation !== "old") return false
    const survived = typeof block.survivedCount === "number" ? block.survivedCount : 0
    return survived >= agingThreshold
}

function estimateMessagesTokens(messages: WithParts[]): number {
    if (!Array.isArray(messages)) return 0
    let total = 0
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.parts)) continue
        for (const part of msg.parts) {
            if (!part) continue
            const p = part as {
                type?: string
                text?: unknown
                state?: { output?: unknown }
            }
            if (typeof p.text === "string") {
                total += countTokensSync(p.text)
            }
            if (p.type === "tool" && p.state && typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
        }
    }
    return total
}
