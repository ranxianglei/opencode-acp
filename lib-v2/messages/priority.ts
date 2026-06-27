import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import { countTokensSync } from "../infra/token-counter"
import { isMessageWithInfo } from "./shape"
import { messageHasCompress, isIgnoredUserMessage } from "./query"
import type { Priority } from "./types"

const HIGH_PRIORITY_TOKENS = 500
const MEDIUM_PRIORITY_TOKENS = 50

const V1_HIGH_PRIORITY_MIN_TOKENS = 5000
const V1_MEDIUM_PRIORITY_MIN_TOKENS = 500

export type MessagePriority = "low" | "medium" | "high"

export function classifyMessagePriority(tokenCount: number): MessagePriority {
    if (tokenCount >= V1_HIGH_PRIORITY_MIN_TOKENS) return "high"
    if (tokenCount >= V1_MEDIUM_PRIORITY_MIN_TOKENS) return "medium"
    return "low"
}

export interface CompressionPriorityEntry {
    ref: string
    tokenCount: number
    priority: MessagePriority
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>

function isProtectedUserMessage(config: PluginConfig, msg: any): boolean {
    return msg?.info?.role === "user" && config.compress.protectUserMessages === true
}

function isMessageCompacted(state: SessionState, msg: WithParts): boolean {
    // Match v1 semantics: when lastCompaction <= 0, no messages are considered
    // compacted yet (the pruneEntry alone doesn't imply active compaction in
    // a fresh session). This keeps newly-mapped messages visible to priority
    // classification until a real compaction event sets lastCompaction.
    if (state.lastCompaction <= 0) return false
    const created = (msg.info as { time?: { created?: number } }).time?.created
    if (created !== undefined) {
        if (created < state.lastCompaction) return true
        if (created === state.lastCompaction && (msg.info as { summary?: boolean }).summary === true) return true
    }
    const entry = state.prune.messages.byMessageId.get(msg.info.id)
    return !!(entry && entry.activeBlockIds.length > 0)
}

function countAllMessageTokens(message: WithParts): number {
    let total = 0
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
        const p = part as { type?: string; text?: unknown; state?: { output?: unknown; input?: unknown } }
        if (typeof p.text === "string") {
            total += countTokensSync(p.text)
        }
        if (p.type === "tool" && p.state) {
            if (typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
            if (p.state.input && typeof p.state.input === "object") {
                try {
                    total += countTokensSync(JSON.stringify(p.state.input))
                } catch {
                    void 0
                }
            }
        }
    }
    return total
}

export function buildPriorityMap(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
): CompressionPriorityMap {
    if (config.compress.mode !== "message") {
        return new Map()
    }
    const priorities: CompressionPriorityMap = new Map()

    for (const message of messages) {
        if (!isMessageWithInfo(message)) continue
        if (isIgnoredUserMessage(message)) continue
        if (isProtectedUserMessage(config, message)) continue
        if (isMessageCompacted(state, message)) continue

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) continue

        const ref = state.messageIds.byRawId.get(rawMessageId)
        if (!ref) continue

        const tokenCount = countAllMessageTokens(message)
        priorities.set(rawMessageId, {
            ref,
            tokenCount,
            priority: messageHasCompress(message) ? "high" : classifyMessagePriority(tokenCount),
        })
    }

    return priorities
}

export function listPriorityRefsBeforeIndex(
    messages: WithParts[],
    priorities: CompressionPriorityMap,
    anchorIndex: number,
    priority: MessagePriority,
): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const upperBound = Math.max(0, Math.min(anchorIndex, messages.length))

    for (let index = 0; index < upperBound; index++) {
        const rawMessageId = messages[index]?.info.id
        if (typeof rawMessageId !== "string") continue

        const entry = priorities.get(rawMessageId)
        if (!entry || entry.priority !== priority || seen.has(entry.ref)) continue

        seen.add(entry.ref)
        refs.push(entry.ref)
    }

    return refs
}

export function classifyMessage(msg: unknown): Priority {
    if (!isMessageWithInfo(msg)) return "low"
    if (msg.info.role === "user") return "high"
    if (msg.info.role === "assistant") {
        if (messageHasCompress(msg)) return "high"
        const tokens = estimateMessageTokens(msg)
        if (tokens >= HIGH_PRIORITY_TOKENS) return "high"
        if (tokens >= MEDIUM_PRIORITY_TOKENS) return "medium"
        return "low"
    }
    return "low"
}

function estimateMessageTokens(msg: WithParts): number {
    let total = 0
    for (const part of msg.parts) {
        if (!part) continue
        const p = part as { type?: string; text?: unknown; state?: { output?: unknown } }
        if (typeof p.text === "string") {
            total += countTokensSync(p.text)
        }
        if (p.type === "tool" && p.state && typeof p.state.output === "string") {
            total += countTokensSync(p.state.output)
        }
    }
    return total
}
