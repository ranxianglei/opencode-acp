import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import { countTokensSync } from "../infra/token-counter"
import { isMessageWithInfo } from "./shape"
import { messageHasCompress } from "./query"
import type { Priority } from "./types"

const HIGH_PRIORITY_TOKENS = 500
const MEDIUM_PRIORITY_TOKENS = 50

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

export function buildPriorityMap(
    _config: PluginConfig,
    _state: SessionState,
    messages: WithParts[],
): Map<string, Priority> {
    const map = new Map<string, Priority>()
    if (!Array.isArray(messages)) return map
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) continue
        const id = msg.info.id
        if (typeof id !== "string" || id === "") continue
        map.set(id, classifyMessage(msg))
    }
    return map
}
