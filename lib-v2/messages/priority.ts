import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import { countTokensSync } from "../infra/token-counter"
import { isMessageWithInfo } from "./shape"
import { messageHasCompress, isIgnoredUserMessage, isProtectedUserMessage } from "./query"
import { isMessageCompacted } from "../state/utils"
import type { Priority } from "./types"

const HIGH_PRIORITY_TOKENS = 500
const MEDIUM_PRIORITY_TOKENS = 50

const V1_HIGH_PRIORITY_MIN_TOKENS = 5000
const V1_MEDIUM_PRIORITY_MIN_TOKENS = 500

export type MessagePriority = "low" | "medium" | "high"

export interface CompressionPriorityEntry {
    ref: string
    tokenCount: number
    priority: MessagePriority
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>

export function classifyMessagePriority(tokenCount: number): MessagePriority {
    if (tokenCount >= V1_HIGH_PRIORITY_MIN_TOKENS) return "high"
    if (tokenCount >= V1_MEDIUM_PRIORITY_MIN_TOKENS) return "medium"
    return "low"
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

function countAllMessageTokens(message: WithParts): number {
    if (!message || !Array.isArray(message.parts)) return 0
    let total = 0
    for (const part of message.parts) {
        if (!part) continue
        const p = part as { type?: string; text?: unknown; state?: { output?: unknown } }
        if (typeof p.text === "string") {
            total += countTokensSync(p.text)
        }
        if (p.type === "tool" && p.state) {
            if (typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
            const input = (p.state as { input?: unknown }).input
            if (typeof input === "string") {
                total += countTokensSync(input)
            } else if (input && typeof input === "object") {
                try {
                    total += countTokensSync(JSON.stringify(input))
                } catch {
                    void input
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
