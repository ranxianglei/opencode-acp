import { SessionState, WithParts } from "./state"
import { estimateAllMessageTokensFast, getCurrentTokenUsage } from "./token-utils"
import { isIgnoredUserMessage, isSyntheticMessage } from "./messages/query"
import { Logger } from "./logger"

/**
 * [Issue #476] Relay usage-inflation detection and repair.
 *
 * `getCurrentTokenUsage` returns the PREVIOUS request's upstream-reported
 * usage (input + cacheRead + cacheWrite + output + reasoning). A third-party
 * relay can inflate that number (#476 measured 1.76–2.05×); the inflated value
 * previously flowed unbound into the growth heuristic and triggered compression
 * nudges with no actionable ranges.
 *
 * This module cross-checks the reported figure against a fast estimate of the
 * ACTUAL outgoing message list. Honest reports stay authoritative — the
 * estimate is only used to detect a jump that the payload does not explain and
 * to substitute for the inflated report on that turn.
 */

/** Reported-usage jump factor above which the payload must also have grown. */
export const RELAY_INFLATION_RATIO = 1.5

/**
 * Below this estimate size, turn-over-turn ratios are noise (small sessions
 * swing wildly between requests) and detection is skipped.
 */
export const PAYLOAD_FLOOR_TOKENS = 5000

/**
 * Fast estimate of the tokens carried by the outgoing message list itself
 * (chars/4 convention, same as Issue #384 heuristics). Excludes synthetic
 * messages (ACP block summaries / injected markers) and ignored user messages,
 * matching how the rest of the pipeline accounts for them.
 */
export function estimatePayloadTokens(messages: WithParts[]): number {
    let total = 0
    for (const msg of messages) {
        if (isSyntheticMessage(msg)) continue
        if (isIgnoredUserMessage(msg)) continue
        total += estimateAllMessageTokensFast(msg)
    }
    return total
}

export interface UsageSanityRecord {
    /** Upstream-reported usage from the previous request (raw, unmodified). */
    reported: number
    /** ACP's own fast estimate of the payload + system prompt that turn. */
    estimated: number
}

export type UsageSource = "reported" | "reestimated"

export interface ResolvedUsage {
    tokens: number
    source: UsageSource
    inflationDetected: boolean
}

/**
 * Resolve the current context-size figure for threshold/growth decisions.
 *
 * - `reported === 0` is the post-compaction sentinel → passthrough (legacy
 *   behavior: baseline reset downstream).
 * - Inflation rule: reported jumped > RELAY_INFLATION_RATIO vs the previous
 *   turn's report while the estimated payload did NOT jump by the same factor
 *   → the relay inflated; use the estimate for this turn.
 * - Always records `{reported, estimated}` on state for the next turn (the raw
 *   reported value, so sustained per-turn inflation is still caught).
 *
 * Known limitation (accepted): a relay that inflates once and then holds a
 * stable inflated value passes the jump test afterwards. An absolute
 * reported-vs-estimate check was rejected because chars/4 undercounts CJK
 * payloads up to ~4× and would false-positive on legitimate CJK sessions.
 */
export function resolveCurrentUsage(
    state: SessionState,
    messages: WithParts[],
    logger?: Logger,
): ResolvedUsage {
    const reported = getCurrentTokenUsage(state, messages)
    if (reported === 0) {
        return { tokens: 0, source: "reported", inflationDetected: false }
    }

    const estimated = estimatePayloadTokens(messages) + (state.systemPromptTokens ?? 0)

    const prev = state.usageSanity
    let inflationDetected = false
    if (
        prev !== undefined &&
        prev.reported > 0 &&
        prev.estimated >= PAYLOAD_FLOOR_TOKENS &&
        estimated >= PAYLOAD_FLOOR_TOKENS
    ) {
        const reportRatio = reported / prev.reported
        const payloadRatio = estimated / prev.estimated
        if (reportRatio > RELAY_INFLATION_RATIO && payloadRatio <= RELAY_INFLATION_RATIO) {
            inflationDetected = true
        }
    }

    state.usageSanity = { reported, estimated }

    if (inflationDetected) {
        logger?.warn("Relay usage inflation detected — re-estimating context size", {
            session: state.sessionId,
            reported,
            previousReported: prev!.reported,
            reportRatio: +(reported / prev!.reported).toFixed(3),
            estimated,
            previousEstimated: prev!.estimated,
            payloadRatio: +(estimated / prev!.estimated).toFixed(3),
        })
        return { tokens: estimated, source: "reestimated", inflationDetected: true }
    }
    return { tokens: reported, source: "reported", inflationDetected: false }
}
