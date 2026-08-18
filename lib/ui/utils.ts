import { SessionState, WithParts } from "../state"
import { countTokens } from "../token-utils"
import { isIgnoredUserMessage } from "../messages/query"

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

export function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): void {
    // [FIX #255] Never overwrite a stable positive cache - after compression
    // the first visible assistant's input includes large history, inflating
    // the estimate.
    if (state.systemPromptTokens !== undefined && state.systemPromptTokens > 0) {
        return
    }

    let firstInputTokens = 0
    for (const msg of messages) {
        if (msg.info.role !== "assistant") {
            continue
        }
        const info = msg.info as any
        const input = info?.tokens?.input || 0
        const cacheRead = info?.tokens?.cache?.read || 0
        const cacheWrite = info?.tokens?.cache?.write || 0
        if (input > 0 || cacheRead > 0 || cacheWrite > 0) {
            firstInputTokens = input + cacheRead + cacheWrite
            break
        }
    }

    if (firstInputTokens <= 0) {
        state.systemPromptTokens = undefined
        return
    }

    let firstUserText = ""
    for (const msg of messages) {
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && !(part as any).ignored) {
                firstUserText += part.text
            }
        }
        break
    }

    const estimatedSystemTokens = Math.max(0, firstInputTokens - countTokens(firstUserText))
    state.systemPromptTokens = estimatedSystemTokens > 0 ? estimatedSystemTokens : undefined
}
