import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { messageContainsProtectedTool } from "../compress/protected-content"
import { isIgnoredUserMessage } from "./query"

const EMERGENCY_PRUNE_STUB = "[Output emergency-pruned to prevent context overflow]"
const EMERGENCY_PRUNE_SUMMARY_STUB = "[Summary emergency-pruned to prevent context overflow]"

export interface EmergencyPruneResult {
    prunedCount: number
    estimatedTokensSaved: number
}

function resolveThreshold(
    value: number | `${number}%` | undefined,
    modelContextLimit: number,
): number | undefined {
    if (value === undefined) return undefined
    if (typeof value === "number") return value
    const parsed = parseFloat(value)
    if (isNaN(parsed)) return undefined
    return Math.round((parsed / 100) * modelContextLimit)
}

export function runEmergencyPrune(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    currentTokens: number,
    modelContextLimit: number,
): EmergencyPruneResult {
    const threshold = resolveThreshold(
        config.compress.emergencyPruneThreshold,
        modelContextLimit,
    )
    if (threshold === undefined || currentTokens < threshold) {
        return { prunedCount: 0, estimatedTokensSaved: 0 }
    }

    const target = resolveThreshold(config.compress.emergencyPruneTarget, modelContextLimit)
    const targetReduction = target !== undefined
        ? currentTokens - target
        : Math.round(currentTokens * 0.1)

    if (targetReduction <= 0) {
        return { prunedCount: 0, estimatedTokensSaved: 0 }
    }

    const protectedTools = config.compress.protectedTools
    const protectedFilePatterns = config.protectedFilePatterns

    const lastUserIdx = messages.findLastIndex(
        (m) => m.info.role === "user" && !isIgnoredUserMessage(m),
    )

    let prunedCount = 0
    let tokensSaved = 0

    for (let i = 0; i < messages.length; i++) {
        if (tokensSaved >= targetReduction) break
        if (i >= lastUserIdx) break

        const msg = messages[i]!
        if (messageContainsProtectedTool(msg, protectedTools, protectedFilePatterns)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (tokensSaved >= targetReduction) break
            if (part.type !== "tool") continue
            if (part.state?.status !== "completed") continue
            const output = part.state?.output
            if (typeof output !== "string" || output.length === 0) continue
            if (output === EMERGENCY_PRUNE_STUB) continue

            const estimatedTokens = Math.ceil(output.length / 4)
            part.state.output = EMERGENCY_PRUNE_STUB
            prunedCount++
            tokensSaved += estimatedTokens
        }
    }

    if (tokensSaved < targetReduction) {
        for (let i = 0; i < messages.length; i++) {
            if (tokensSaved >= targetReduction) break
            if (i >= lastUserIdx) break

            const msg = messages[i]!
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (tokensSaved >= targetReduction) break
                if (part.type !== "tool") continue
                if (part.tool !== "compress") continue
                const input = part.state?.input
                if (!input || typeof input === "string") continue
                const rawInput = JSON.stringify(input)
                if (rawInput.includes(EMERGENCY_PRUNE_SUMMARY_STUB)) continue

                const estimatedTokens = Math.ceil(rawInput.length / 4)
                ;(part.state as { input: unknown }).input = EMERGENCY_PRUNE_SUMMARY_STUB
                prunedCount++
                tokensSaved += estimatedTokens
            }
        }
    }

    if (prunedCount > 0) {
        logger.warn("Emergency pruned to prevent context overflow", {
            prunedCount,
            estimatedTokensSaved: tokensSaved,
            currentTokens,
            threshold,
            target,
        })
    }

    return { prunedCount, estimatedTokensSaved: tokensSaved }
}
