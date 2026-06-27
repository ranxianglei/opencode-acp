import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import type { SessionState, WithParts } from "../state/types"
import type { Logger } from "./logger"
import { getLastUserMessage } from "../messages/query"

// The @anthropic-ai/tokenizer package exposes countTokens as a named export,
// but under some bundler/interop configurations it appears under default.countTokens.
interface TokenizerModule {
    countTokens?: (text: string) => number
    default?: {
        countTokens?: (text: string) => number
    }
}

interface Tokenizer {
    countTokens: (text: string) => number
}

let tokenizer: Tokenizer | null = null

async function loadTokenizerAsync(): Promise<Tokenizer | null> {
    if (tokenizer) return tokenizer
    try {
        const mod: TokenizerModule = await import("@anthropic-ai/tokenizer")
        const candidate = mod.countTokens ?? mod.default?.countTokens
        if (typeof candidate === "function") {
            tokenizer = { countTokens: candidate }
        }
        return tokenizer
    } catch {
        return null
    }
}

function loadTokenizerSync(): Tokenizer | null {
    return tokenizer
}

function fallbackEstimate(text: string): number {
    return Math.round(text.length / 4)
}

export async function countTokens(text: string): Promise<number> {
    if (!text) return 0
    const tok = await loadTokenizerAsync()
    if (tok) {
        try {
            return tok.countTokens(text)
        } catch {
            return fallbackEstimate(text)
        }
    }
    return fallbackEstimate(text)
}

export function countTokensSync(text: string): number {
    if (!text) return 0
    const tok = loadTokenizerSync()
    if (tok) {
        try {
            return tok.countTokens(text)
        } catch {
            return fallbackEstimate(text)
        }
    }
    return fallbackEstimate(text)
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokensSync(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

function isToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
    return part.type === "tool"
}

export function extractCompletedToolOutput(part: Part): string | undefined {
    if (!isToolPart(part)) return undefined
    const state = part.state
    if (state.status !== "completed") return undefined
    if (state.time?.compacted !== undefined) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }
    // SDK type says output is always string, but real-world / test fixtures
    // may contain objects or arrays — normalize via stringifyToolContent.
    return stringifyToolContent(state.output)
}

export function extractToolContent(part: Part): string[] {
    const contents: string[] = []
    if (!isToolPart(part)) return contents

    contents.push(stringifyToolContent(part.state.input))

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state.status === "error") {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: Part): number {
    return estimateTokensBatch(extractToolContent(part))
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

function collectMessageTexts(msg: WithParts): string[] {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    return texts
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts = collectMessageTexts(msg)
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export interface CurrentParams {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
}

export function getCurrentParams(
    _state: SessionState,
    messages: WithParts[],
    logger: Logger,
): CurrentParams {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const info = userMsg.info
    if (info.role !== "user") {
        logger.debug("Last user message has non-user role", { role: info.role })
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
        agent: userInfo.agent,
        variant: userInfo.model.variant,
    }
}

/**
 * [FIX Bug 4] Returns the most recent fresh assistant message's reported token usage.
 *
 * Total = input + cache.read + cache.write + output + reasoning
 * (input excludes cache hits; adding them back yields the full prompt_tokens total.)
 *
 * Returns 0 when the only assistant messages predate the last compaction — their
 * totals are stale. Falls back to a text-length estimate when no assistant has
 * reported output tokens yet (first turn or immediately after full compaction).
 */
export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg) continue

        const info = msg.info
        if (info.role !== "assistant") continue

        const assistantInfo = info as AssistantMessage
        const tokens = assistantInfo.tokens
        if ((tokens?.output ?? 0) <= 0) continue

        if (state.lastCompaction > 0) {
            const created = assistantInfo.time?.created ?? 0
            if (
                created < state.lastCompaction ||
                (assistantInfo.summary === true && created === state.lastCompaction)
            ) {
                return 0
            }
        }

        const input = tokens.input ?? 0
        const output = tokens.output ?? 0
        const reasoning = tokens.reasoning ?? 0
        const cacheRead = tokens.cache.read ?? 0
        const cacheWrite = tokens.cache.write ?? 0

        return input + cacheRead + cacheWrite + output + reasoning
    }

    let estimated = 0
    for (const m of messages) {
        if (!m) continue
        const parts = Array.isArray(m.parts) ? m.parts : []
        for (const part of parts) {
            if (part.type === "text") {
                estimated += countTokensSync(part.text)
            }
        }
    }
    return estimated
}
