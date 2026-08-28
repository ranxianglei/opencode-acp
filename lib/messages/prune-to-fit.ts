import { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { Logger } from "../logger"
import {
    getCurrentTokenUsage,
    countTokens,
    countAllMessageTokens,
    extractCompletedToolOutput,
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
} from "../token-utils"
import {
    isToolNameProtected,
    getFilePathsFromParameters,
    isFilePathProtected,
} from "../protected-patterns"
import { computeProtectedRefs, findLastNonIgnoredMessage } from "./inject/utils"

/**
 * [FIX #347] Request-side hard guard ("prune-to-fit").
 *
 * When the estimated wire size of the outgoing request exceeds
 * `safeBudget = knownWindow - overflowGuardReserve`, deterministically clear the
 * oldest compressible (non-protected) tool outputs until the estimate fits —
 * independent of model cooperation. This converts a hard provider 400
 * ("Requested token count exceeds the model's maximum context length") into a
 * degraded-but-working turn, instead of a silent exit-0 death loop.
 *
 * `knownWindow` is `state.modelContextLimit` (the real window, when the model
 * reports one) OR the absolute `compress.maxContextLimit` /
 * `compress.modelMaxLimits[provider/model]` (a number, not a percent) as a
 * conservative lower bound. When neither is available the guard cannot fire —
 * the uncalibrated-window WARN (Fix 1, hooks.ts) tells the user to configure a
 * window so this guard can protect them.
 */

/** Extra tokens added on top of the provider-reported usage to cover the new
 *  user message + nudges that are appended after the last assistant turn. */
const WIRE_SAFETY_MARGIN = 8192

/** Placeholder written into a cleared tool output. Distinct from opencode's own
 *  compaction placeholder so the two mechanisms are distinguishable in logs. */
const CLEAR_PLACEHOLDER = "[cleared by ACP overflow guard — re-run tool if needed]"

/** Only clear outputs large enough that clearing them is worth the churn. */
const MIN_CLEAR_TOKENS = 500

/**
 * Resolve the context window the guard should keep the request within.
 *
 * Returns:
 * - `state.modelContextLimit` when the model reports a window (the real window);
 * - else the absolute `compress.modelMaxLimits[provider/model]` (number);
 * - else the absolute `compress.maxContextLimit` (number);
 * - else `undefined` (percent values cannot be resolved without a window — the
 *   guard stays off and the uncalibrated-window WARN guides the user).
 */
export function resolveKnownWindow(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): number | undefined {
    if (state.modelContextLimit !== undefined) {
        return state.modelContextLimit
    }

    const maxLimits = config.compress.modelMaxLimits
    if (maxLimits && providerId !== undefined && modelId !== undefined) {
        const perModel = maxLimits[`${providerId}/${modelId}`]
        if (typeof perModel === "number") return perModel
    }

    const global = config.compress.maxContextLimit
    if (typeof global === "number") return global

    return undefined
}

/**
 * Estimate the outgoing request's wire size (tokens).
 *
 * Primary: the last assistant turn's provider-reported usage
 * (`getCurrentTokenUsage`) — the context size AFTER that LLM call — plus:
 * (1) the trailing completed tool outputs of the last assistant message, which
 *     are appended AFTER the last LLM call and so absent from that usage
 *     (opencode runs messages.transform on every LLM call; a mid-turn
 *     sub-request otherwise misses fresh tool outputs — issue #347 B1). The
 *     trailing-run count is exact when the last step has text and only
 *     over-counts for tool-calls-only steps (safe: clears more, never less);
 * (2) {@link WIRE_SAFETY_MARGIN} for the new user message + nudges.
 *
 * Fallback (only when `getCurrentTokenUsage` is 0): precise count of all
 * message content + system prompt.
 */
function estimateWireTokens(state: SessionState, messages: WithParts[]): number {
    const base = getCurrentTokenUsage(state, messages)
    if (base > 0) {
        // Trailing completed tool outputs were appended after the last LLM call,
        // so they are absent from `base` — count them (issue #347 B1).
        let trailing = 0
        const lastAsst = [...messages].reverse().find((m) => m.info.role === "assistant")
        if (lastAsst) {
            const parts = Array.isArray(lastAsst.parts) ? lastAsst.parts : []
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i]
                if (p?.type !== "tool") break
                if (p.state.status !== "completed") break
                trailing += countTokens(extractCompletedToolOutput(p) ?? "")
            }
        }
        return base + trailing + WIRE_SAFETY_MARGIN
    }

    let total = 0
    for (const msg of messages) {
        total += countAllMessageTokens(msg)
    }
    return total + (state.systemPromptTokens ?? 0) + WIRE_SAFETY_MARGIN
}

/**
 * Deterministically clear the oldest compressible (non-protected) tool outputs
 * until the estimated wire size fits within `safeBudget`. Mutates the tool parts
 * in place (same mechanism as `truncateLargeToolOutputs`).
 *
 * No-op when the guard is disabled, no window is known, or the estimate already
 * fits. Logs a WARN when it clears outputs to fit and an ERROR when it clears
 * everything it can but the context still exceeds the window.
 */
export function pruneToFit(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    if (!config.compress.overflowGuard) return

    const knownWindow = resolveKnownWindow(config, state, state.modelProviderID, state.modelID)
    if (knownWindow === undefined) return

    const reserve = config.compress.overflowGuardReserve ?? 32768
    const safeBudget = knownWindow - reserve
    if (safeBudget <= 0) return

    const estimate = estimateWireTokens(state, messages)
    if (estimate <= safeBudget) return

    const protectedRefs = computeProtectedRefs(messages, state, config.compress)
    const lastNonIgnored = findLastNonIgnoredMessage(messages)
    const lastMsgId = lastNonIgnored?.message.info.id
    const protectedTools = config.compress.protectedTools
    const protectedFilePatterns = config.protectedFilePatterns

    let freed = 0
    let clearedCount = 0

    // Oldest → newest so the least-recent (least-relevant) outputs go first.
    for (const msg of messages) {
        if (estimate - freed <= safeBudget) break

        // Never touch the current turn.
        if (msg.info.id === lastMsgId) continue
        if (msg.info.role === "user") continue

        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (ref && protectedRefs.has(ref)) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (estimate - freed <= safeBudget) break
            if (part?.type !== "tool") continue

            // Narrow the ToolState discriminated union to the completed variant
            // (the only one carrying `output` / `input`).
            const toolState = part.state
            if (toolState.status !== "completed") continue

            const content = extractCompletedToolOutput(part)
            if (content === undefined) continue
            // Idempotency: skip outputs already cleared by this guard or by
            // opencode's own compaction.
            if (content === CLEAR_PLACEHOLDER) continue
            if (content === COMPACTED_TOOL_OUTPUT_PLACEHOLDER) continue

            // Hard-exclude protected tools / protected file paths (Bug 39 parity).
            if (isToolNameProtected(part.tool, protectedTools)) continue
            if (protectedFilePatterns.length > 0) {
                const filePaths = getFilePathsFromParameters(part.tool, toolState.input)
                if (isFilePathProtected(filePaths, protectedFilePatterns)) continue
            }

            const outputTokens = countTokens(content)
            if (outputTokens < MIN_CLEAR_TOKENS) continue

            toolState.output = CLEAR_PLACEHOLDER
            freed += outputTokens - countTokens(CLEAR_PLACEHOLDER)
            clearedCount++
        }
    }

    const after = estimate - freed
    const detail = {
        session: state.sessionId,
        estimate,
        safeBudget,
        knownWindow,
        reserve,
        clearedCount,
        freedTokens: Math.round(freed),
        afterTokens: Math.round(after),
    }
    if (clearedCount === 0) {
        // Over budget but nothing was clearable — the request is still about to
        // 400. Surface it so the user knows the guard could not help.
        logger.error("ACP overflow guard: over window but no clearable tool outputs", detail)
        return
    }
    if (after <= safeBudget) {
        logger.warn("ACP overflow guard: cleared tool outputs to fit context window", detail)
    } else {
        logger.error(
            "ACP overflow guard: cleared tool outputs but context STILL exceeds window",
            detail,
        )
    }
}
