import { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { Logger } from "../logger"
import { getCurrentTokenUsage, countTokens, extractCompletedToolOutput } from "../token-utils"

const TRUNCATION_MARKER = "[truncated for context space"
const MIN_OUTPUT_TOKENS = 1000
const KEEP_PREFIX_CHARS = 2000
const KEEP_SUFFIX_CHARS = 2000
const PROTECT_RECENT_MESSAGES = 3

function parseGcThreshold(
    threshold: number | `${number}%` | undefined,
    modelContextLimit: number,
): number {
    if (typeof threshold === "number") return threshold
    const str = threshold ?? "100%"
    const match = /^(\d+(?:\.\d+)?)%$/.exec(str)
    if (match) return Math.round((Number(match[1]) / 100) * modelContextLimit)
    return modelContextLimit
}

/**
 * When context reaches the GC threshold, truncate the largest visible tool outputs
 * (keeping prefix + suffix) to free space. Summaries are never touched — they contain
 * distilled information. Only verbose tool outputs (build logs, listings) are truncated.
 */
export function truncateLargeToolOutputs(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    if (!state.modelContextLimit) return

    const currentTokens = getCurrentTokenUsage(state, messages)
    if (currentTokens === 0) return

    const threshold = parseGcThreshold(config.gc?.majorGcThresholdPercent, state.modelContextLimit)
    if (currentTokens < threshold) return

    const protectedIndex = messages.length - PROTECT_RECENT_MESSAGES

    const candidates: Array<{ part: any; content: string; tokens: number }> = []

    for (let mi = 0; mi < messages.length; mi++) {
        if (mi >= protectedIndex) break

        const msg = messages[mi]
        const parts = Array.isArray(msg.parts) ? msg.parts : []

        for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi]
            if (part?.type !== "tool") continue
            if (part.state?.status !== "completed") continue

            const content = extractCompletedToolOutput(part)
            if (content === undefined) continue
            if (content === "[Old tool result content cleared]") continue
            if (content.includes(TRUNCATION_MARKER)) continue

            const tokens = countTokens(content)
            if (tokens < MIN_OUTPUT_TOKENS) continue

            candidates.push({ part, content, tokens })
        }
    }

    if (candidates.length === 0) return

    candidates.sort((a, b) => b.tokens - a.tokens)

    const targetTokens = threshold * 0.9
    let savedTokens = 0
    let truncatedCount = 0

    for (const { part, content, tokens } of candidates) {
        if (currentTokens - savedTokens <= targetTokens) break

        if (content.length <= KEEP_PREFIX_CHARS + KEEP_SUFFIX_CHARS) continue

        const prefix = content.slice(0, KEEP_PREFIX_CHARS)
        const suffix = content.slice(-KEEP_SUFFIX_CHARS)
        const truncated =
            prefix +
            `\n\n...${TRUNCATION_MARKER} — original ~${tokens} tokens]...\n\n` +
            suffix

        part.state.output = truncated
        savedTokens += tokens - countTokens(truncated)
        truncatedCount++
    }

    if (truncatedCount > 0) {
        logger.info("Emergency tool output truncation", {
            truncatedCount,
            estimatedSavedTokens: Math.round(savedTokens),
            currentTokens,
            threshold,
        })
    }
}
