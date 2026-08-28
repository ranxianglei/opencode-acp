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
 *     sub-request otherwise misses fresh tool outputs — issue #347 B1). This
 *     count is exact for both text and tool-calls-only steps: a step's own
 *     usage cannot include its own tool results;
 * (2) any messages after the last assistant (typically the current user message
 *     on a new turn), also absent from that usage (review N2);
 * (3) {@link WIRE_SAFETY_MARGIN} for nudges / ID tags appended after the guard.
 *
 * Falls back to {@link preciseWireTokens} (count every message's content) when
 * there is no provider usage data, OR when the usage is known-stale: the last
 * assistant step ran a `compress`, so `base` still includes the range that
 * `prune()` is about to replace with a summary (review N1).
 */
function estimateWireTokens(state: SessionState, messages: WithParts[]): number {
    const base = getCurrentTokenUsage(state, messages)
    if (base > 0) {
        // Backward scan for the last assistant message — O(1) in the common case
        // where it is the most recent message (no array copy; review T1).
        let lastAsstIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].info.role === "assistant") {
                lastAsstIdx = i
                break
            }
        }

        // A completed `compress` in the last assistant step means `base` still
        // includes the range prune() has (or will) replace with a summary — the
        // base is stale by (compressed − summary) tokens. Count the already-
        // pruned messages precisely instead of over-clearing (review N1).
        if (lastAsstIdx >= 0 && hasCompletedCompressPart(messages[lastAsstIdx]!)) {
            return preciseWireTokens(state, messages)
        }

        // Trailing completed tool outputs were appended after the last LLM call,
        // so they are absent from `base` — count them (issue #347 B1).
        let trailing = 0
        if (lastAsstIdx >= 0) {
            const parts = Array.isArray(messages[lastAsstIdx]!.parts)
                ? messages[lastAsstIdx]!.parts
                : []
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i]
                if (p?.type !== "tool") break
                if (p.state.status !== "completed") break
                trailing += countTokens(extractCompletedToolOutput(p) ?? "")
            }
        }

        // Messages after the last assistant (usually the current user message on
        // a new turn) are also absent from `base` — count them (review N2).
        let afterLastAsst = 0
        for (let i = lastAsstIdx + 1; i < messages.length; i++) {
            afterLastAsst += countAllMessageTokens(messages[i]!)
        }

        return base + trailing + afterLastAsst + WIRE_SAFETY_MARGIN
    }

    return preciseWireTokens(state, messages)
}

/** Precise wire-size estimate: count the content of every message ourselves,
 *  plus the system prompt. Used when there is no provider usage data, or when
 *  the provider usage is known-stale (a compression just ran). */
function preciseWireTokens(state: SessionState, messages: WithParts[]): number {
    let total = state.systemPromptTokens ?? 0
    for (const msg of messages) {
        total += countAllMessageTokens(msg)
    }
    return total + WIRE_SAFETY_MARGIN
}

function hasCompletedCompressPart(message: WithParts): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const p of parts) {
        if (p?.type === "tool" && p.tool === "compress" && p.state.status === "completed") {
            return true
        }
    }
    return false
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
    if (estimate <= safeBudget) {
        // Back under budget — clear the stuck flag so a future stuck episode
        // logs its ERROR again (review N3).
        state.overflowGuardStuckLogged = false
        return
    }

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
        // 400. This condition persists across transforms, so log it once per
        // stuck episode (the flag resets when the estimate drops under budget).
        if (!state.overflowGuardStuckLogged) {
            state.overflowGuardStuckLogged = true
            logger.error("ACP overflow guard: over window but no clearable tool outputs", detail)
        }
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
