import { SessionState, WithParts } from "../state"
import { calibrateSystemOverhead } from "../token-utils"

export function formatAge(createdAt: number): string {
    const elapsed = Date.now() - createdAt
    if (elapsed < 60_000) return "just now"
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
    return `${Math.floor(elapsed / 86_400_000)}d ago`
}

export function formatTokenCount(tokens: number, compact?: boolean): string {
    const suffix = compact ? "" : " tokens"
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + suffix
    }
    return tokens.toString() + suffix
}

export function formatProgressBar(
    messageIds: string[],
    prunedMessages: Map<string, number>,
    recentMessageIds: string[],
    width: number = 50,
): string {
    const ACTIVE = "█"
    const PRUNED = "░"
    const RECENT = "⣿"
    const recentSet = new Set(recentMessageIds)

    const total = messageIds.length
    if (total === 0) return `│${PRUNED.repeat(width)}│`

    const bar = new Array(width).fill(ACTIVE)

    for (let m = 0; m < total; m++) {
        const msgId = messageIds[m]
        const start = Math.floor((m / total) * width)
        const end = Math.floor(((m + 1) / total) * width)

        if (recentSet.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = RECENT
            }
        } else if (prunedMessages.has(msgId)) {
            for (let i = start; i < end; i++) {
                bar[i] = PRUNED
            }
        }
    }

    return `│${bar.join("")}│`
}

export function cacheSystemPromptTokens(
    state: SessionState,
    messages: WithParts[],
    measuredSystemTokens?: number,
): void {
    // [FIX #255] Never overwrite a stable positive cache - after compression
    // the first visible assistant's input includes large history, inflating
    // the estimate.
    if (state.systemPromptTokens !== undefined && state.systemPromptTokens > 0) {
        return
    }

    // [FIX #421] Heuristic calibration is guarded against compaction summaries
    // and pre-compaction usage (see calibrateSystemOverhead). A measured value
    // — the actual outgoing system parts tokenized on the current wire — acts
    // as a floor: the anchor-derived residual also covers tool schemas, so the
    // larger of the two wins.
    const calibrated = calibrateSystemOverhead(state, messages)
    const measured = measuredSystemTokens ?? 0
    const estimated = Math.max(calibrated, measured)

    if (estimated <= 0) {
        state.systemPromptTokens = undefined
        state.systemPromptTokensSource = undefined
        return
    }

    state.systemPromptTokens = estimated
    state.systemPromptTokensSource = calibrated > measured ? "heuristic" : "measured"
}
