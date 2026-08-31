import { SessionState, WithParts } from "../state"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { PluginConfig } from "../config"
import { Logger } from "../logger"
import {
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
    countAllMessageTokens,
    countTokens,
    extractCompletedToolOutput,
    getCurrentTokenUsage,
} from "../token-utils"

/**
 * Default completion reserve in tokens. opencode falls back to max_tokens=32000
 * when the model's limit.output is unknown/0, so the reserve must cover that
 * worst case (billion-context#317: 230527 input + 32000 completion > 262144
 * window → 400 → silent exit 0).
 */
export const DEFAULT_COMPLETION_RESERVE_TOKENS = 32768

const TRUNCATION_MARKER = "[truncated for context space"
const KEEP_PREFIX_CHARS = 2000
const KEEP_SUFFIX_CHARS = 2000
const PROTECT_RECENT_MESSAGES = 3
const MIN_CLEAR_TOKENS = 200

export interface EnforceBudgetResult {
    applied: boolean
    window: number
    reserve: number
    budget: number
    estimatedTokens: number
    finalEstimate: number
    truncatedCount: number
    clearedCount: number
}

/**
 * Resolve the context window the budget guard enforces against.
 *
 * ONLY the model-reported window (state.modelContextLimit) is used. An
 * absolute compress.maxContextLimit is deliberately NOT a fallback: it is a
 * soft nudge/compression threshold, not the backend's real limit. Pruning to
 * a guessed threshold destroys context the backend would have accepted (and
 * starves the nudge of its compressible targets — see
 * e2e-blocks-nudges "compressible ranges injected" regression). Users with
 * an unknown window get the loud one-time warning from hooks.ts instead.
 */
export function resolveContextWindow(state: SessionState): number | undefined {
    if (typeof state.modelContextLimit === "number" && state.modelContextLimit > 0) {
        return state.modelContextLimit
    }
    return undefined
}

/**
 * Estimate the input token count of the request about to be sent.
 *
 * Primary: the last assistant message's reported usage (input + cacheRead +
 * cacheWrite + output + reasoning — exactly what the model saw last turn plus
 * what it produced, which is now history) + the tokens of every message after
 * it (the new user message of this turn).
 *
 * Fallback (no assistant token data yet): full content estimate of all
 * messages + the cached system prompt estimate.
 */
export function estimateWireTokens(state: SessionState, messages: WithParts[]): number {
    const base = getCurrentTokenUsage(state, messages)
    if (base > 0) {
        // Align with getCurrentTokenUsage: base is the usage of the LAST
        // assistant WITH token data (it skips tokenless aborted requests).
        // Count additions after that same assistant — not after the last
        // assistant by role. If the role-last assistant has no token data,
        // the gap between the two (user message + aborted output) would
        // otherwise be undercounted.
        let baseAssistant = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].info.role !== "assistant") continue
            const tokens = (messages[i].info as AssistantMessage).tokens
            if ((tokens?.input || 0) <= 0 && (tokens?.output || 0) <= 0) continue
            baseAssistant = i
            break
        }
        if (baseAssistant >= 0) {
            let additions = 0
            for (let i = baseAssistant + 1; i < messages.length; i++) {
                additions += countAllMessageTokens(messages[i])
            }
            return base + additions
        }
        // base > 0 without a token-data assistant means getCurrentTokenUsage
        // itself fell back to content estimation — redo it here with the
        // system prompt estimate included.
    }

    let total = 0
    for (const m of messages) total += countAllMessageTokens(m)
    return total + (state.systemPromptTokens ?? 0)
}

/**
 * Deterministic prune-to-fit: shrink compressible tool outputs until the
 * estimated request fits `window - reserve`. Runs after
 * truncateLargeToolOutputs (which only fires on a known modelContextLimit and
 * only above the GC threshold), so it is the last line of defense against the
 * model backend rejecting the request (HTTP 400 → opencode exit 0, no output).
 *
 * Phase 1: truncate the largest old tool outputs (prefix + suffix kept, same
 * marker as truncateLargeToolOutputs for idempotency).
 * Phase 2: if still over budget, clear the oldest remaining outputs to the
 * standard cleared placeholder.
 *
 * Never touches: the first user message, the last 3 messages, protectedTools,
 * compress-tool outputs (summaries), or already-cleared outputs.
 *
 * Note: the estimate is computed before message-ID tags and nudge text are
 * injected later in the pipeline; those additions (a few hundred tokens) are
 * absorbed by the completion reserve.
 */
export function enforceContextBudget(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): EnforceBudgetResult | undefined {
    const window = resolveContextWindow(state)
    if (window === undefined) return undefined

    // Config validation warns on bad values but does not block loading, so
    // defend here: a non-numeric reserve would make `budget` NaN and every
    // `<= budget` break condition false → the guard would truncate ALL
    // candidates with no early exit.
    const configuredReserve = config.compress?.completionReserveTokens
    const reserve =
        typeof configuredReserve === "number" &&
        Number.isFinite(configuredReserve) &&
        configuredReserve >= 0
            ? configuredReserve
            : DEFAULT_COMPLETION_RESERVE_TOKENS
    const budget = window - reserve
    if (budget <= 0) return undefined

    const estimatedTokens = estimateWireTokens(state, messages)
    if (estimatedTokens <= budget) {
        return {
            applied: false,
            window,
            reserve,
            budget,
            estimatedTokens,
            finalEstimate: estimatedTokens,
            truncatedCount: 0,
            clearedCount: 0,
        }
    }

    const protectedIndex = messages.length - PROTECT_RECENT_MESSAGES
    const protectedTools = new Set(config.compress?.protectedTools ?? [])

    const candidates: Array<{ part: any; content: string; tokens: number; index: number }> = []
    for (let mi = 0; mi < protectedIndex; mi++) {
        if (mi === 0 && messages[mi].info.role === "user") continue
        const msg = messages[mi]
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part?.type !== "tool") continue
            if (part.state?.status !== "completed") continue
            if (part.tool === "compress") continue
            if (protectedTools.has(part.tool)) continue

            const content = extractCompletedToolOutput(part)
            if (content === undefined) continue
            if (content === COMPACTED_TOOL_OUTPUT_PLACEHOLDER) continue

            const tokens = countTokens(content)
            if (tokens <= 0) continue
            candidates.push({ part, content, tokens, index: mi })
        }
    }

    let saved = 0
    let truncatedCount = 0
    let clearedCount = 0

    const truncatable = candidates
        .filter(
            (c) =>
                !c.content.includes(TRUNCATION_MARKER) &&
                c.content.length > KEEP_PREFIX_CHARS + KEEP_SUFFIX_CHARS,
        )
        .sort((a, b) => b.tokens - a.tokens)

    for (const c of truncatable) {
        if (estimatedTokens - saved <= budget) break
        const prefix = c.content.slice(0, KEEP_PREFIX_CHARS)
        const suffix = c.content.slice(-KEEP_SUFFIX_CHARS)
        const truncated =
            prefix +
            `\n\n...${TRUNCATION_MARKER} — original ~${c.tokens} tokens]...\n\n` +
            suffix
        // Content just over the 4000-char threshold: prefix and suffix
        // overlap and the marker line makes the "truncated" form LONGER.
        // Skip it (phase 2 may still clear it) instead of growing it.
        if (truncated.length >= c.content.length) continue
        c.part.state.output = truncated
        saved += c.tokens - countTokens(truncated)
        truncatedCount++
    }

    if (estimatedTokens - saved > budget) {
        const clearable = candidates
            .filter((c) => {
                const out = extractCompletedToolOutput(c.part)
                return (
                    out !== undefined &&
                    out !== COMPACTED_TOOL_OUTPUT_PLACEHOLDER &&
                    countTokens(out) > MIN_CLEAR_TOKENS
                )
            })
            .sort((a, b) => a.index - b.index)

        for (const c of clearable) {
            if (estimatedTokens - saved <= budget) break
            const current = extractCompletedToolOutput(c.part)
            if (current === undefined || current === COMPACTED_TOOL_OUTPUT_PLACEHOLDER) continue
            c.part.state.output = COMPACTED_TOOL_OUTPUT_PLACEHOLDER
            saved += countTokens(current) - countTokens(COMPACTED_TOOL_OUTPUT_PLACEHOLDER)
            clearedCount++
        }
    }

    const finalEstimate = Math.max(0, estimatedTokens - saved)
    if (truncatedCount > 0 || clearedCount > 0) {
        logger.warn("Context budget guard: pruned tool outputs to fit the request", {
            session: state.sessionId,
            estimatedTokens: Math.round(estimatedTokens),
            budget,
            window,
            reserve,
            truncatedCount,
            clearedCount,
            estimatedSavedTokens: Math.round(saved),
            finalEstimate: Math.round(finalEstimate),
        })
    }
    if (finalEstimate > budget) {
        logger.warn(
            "Context budget guard: still over budget after pruning all compressible tool outputs; the request may be rejected by the model",
            {
                session: state.sessionId,
                finalEstimate: Math.round(finalEstimate),
                budget,
                window,
            },
        )
    }

    return {
        applied: truncatedCount > 0 || clearedCount > 0,
        window,
        reserve,
        budget,
        estimatedTokens,
        finalEstimate,
        truncatedCount,
        clearedCount,
    }
}
