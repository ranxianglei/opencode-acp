import { SessionState, WithParts } from "./state"
import { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger"
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    (_anthropicTokenizer as any).default?.countTokens) as typeof _anthropicTokenizer.countTokens
import { getLastUserMessage, isIgnoredUserMessage } from "./messages/query"
import { isAcpOwnedNoticeId } from "./synthetic-ids"

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0

        // [FIX output=0 underestimation] Accept input-only token data (output=0
        // from aborted/hidden requests). input + cacheRead + cacheWrite still
        // represents the prompt size sent to the model. Previously required
        // output > 0, which skipped these and fell through to text-only
        // estimation → massive undercount → no nudge fired → context overflow.
        if (input <= 0 && output <= 0) {
            continue
        }

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            return 0
        }

        // [FIX Bug 17] Universal token estimation
        // opencode session.ts: adjustedInputTokens = inputTokens - cacheRead - cacheWrite
        // So: input + cacheRead + cacheWrite = prompt_tokens (total input)
        // Total context usage = prompt_tokens + output + reasoning
        return input + cacheRead + cacheWrite + output + reasoning
    }

    // [FIX Bug 5] fallback: estimate from all content (text + tool outputs)
    // when no assistant message has token data (first turn or full compaction).
    let estimated = 0
    for (const m of messages) {
        estimated += countAllMessageTokens(m)
    }
    return estimated
}

/**
 * [FIX #421] Whether an assistant message may serve as the calibration anchor
 * for system-overhead estimation. Two classes are NOT valid anchors:
 *
 * - Compaction/checkpoint assistants (`info.summary === true`). In V2 these
 *   carry the compaction REQUEST's own token usage verbatim
 *   (lib/v2/projection/shared.ts makeAssistantInfo), not a conversational
 *   prompt — calibrating from them stores the compaction request size as a
 *   permanent phantom system overhead (issue #421).
 * - Assistants created before `state.lastCompaction`. Their prompts describe a
 *   context window that no longer exists after native compaction.
 *
 * Mirrors the guard already used by getCurrentTokenUsage above.
 */
function isCalibrationAnchor(msg: WithParts, lastCompaction: number): boolean {
    if (msg.info.role !== "assistant") return false
    const assistantInfo = msg.info as AssistantMessage
    const t = assistantInfo.tokens
    if (!t) return false
    if ((t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) <= 0) return false
    if (assistantInfo.summary === true) return false
    if (lastCompaction > 0 && (assistantInfo.time?.created ?? 0) < lastCompaction) return false
    return true
}

/**
 * [FIX #421] Estimate the non-message wire overhead (system prompt + tool
 * schemas) from the first trustworthy assistant response.
 *
 * The anchor's input tokens = system + tools + every wire-visible message sent
 * before it. Subtracting only the first user text underestimates whenever
 * earlier conversation content is present (e.g. a post-compaction summary or
 * prior turns), so we subtract the full prefix instead. Messages the host
 * marks as ignored, and ACP-owned V2 notices that are stripped from outgoing
 * requests, never reach the provider — they are excluded from the prefix.
 *
 * Uses the real Anthropic tokenizer via countAllMessageTokens — NOT length/4 —
 * for consistency with /acp context and cacheSystemPromptTokens.
 *
 * Returns 0 when no trustworthy anchor exists (caller should fall back to a
 * measured value or a whole-context estimate).
 */
export function calibrateSystemOverhead(
    state: { lastCompaction?: number },
    messages: WithParts[],
): number {
    const lastCompaction = state.lastCompaction ?? 0
    let anchorIndex = -1
    let anchorInput = 0
    for (let i = 0; i < messages.length; i++) {
        if (!isCalibrationAnchor(messages[i], lastCompaction)) continue
        const t = (messages[i].info as AssistantMessage).tokens!
        anchorIndex = i
        anchorInput = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
        break
    }
    if (anchorIndex === -1) return 0

    let prefixTokens = 0
    for (let i = 0; i < anchorIndex; i++) {
        const msg = messages[i]
        if (isIgnoredUserMessage(msg)) continue
        if (isAcpOwnedNoticeId(msg.info.id)) continue
        prefixTokens += countAllMessageTokens(msg)
    }
    return Math.max(0, anchorInput - prefixTokens)
}

/**
 * Estimate system prompt tokens by subtracting the pre-anchor conversation
 * from the first trustworthy assistant's total input prompt tokens.
 *
 * Delegates to calibrateSystemOverhead ([FIX #421] guards against compaction
 * summaries and stale pre-compaction usage). `lastCompaction` defaults to 0
 * (no native compaction recorded) which preserves legacy behavior for callers
 * without session state.
 *
 * Returns 0 if no trustworthy assistant message with token data is found.
 */
export function estimateSystemPromptTokens(messages: WithParts[], lastCompaction = 0): number {
    return calibrateSystemOverhead({ lastCompaction }, messages)
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
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
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = userInfo.model.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
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

export function countMessageCharacters(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    let total = 0
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            total += part.text.length
        } else {
            for (const content of extractToolContent(part)) {
                total += content.length
            }
        }
    }
    return total
}

/**
 * [Issue #384] Fast per-message token estimate using the chars/4 convention
 * already used across the codebase for token statistics (tool-cache.ts,
 * pipeline.ts, inject/utils.ts). The BPE-exact countAllMessageTokens costs
 * ~25ms/message on this runtime and dominated candidate planning on wide
 * draft ranges; these counters feed heuristic stats/gates, not billing.
 */
export function estimateAllMessageTokensFast(msg: WithParts): number {
    return Math.round(countMessageCharacters(msg) / 4)
}
