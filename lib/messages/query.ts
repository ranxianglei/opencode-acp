import type { WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

export function isIgnoredUserMessage(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false
    const m = msg as Partial<WithParts>
    if (!m.info || typeof m.info !== "object") return false
    if (m.info.role !== "user") return false
    if (!Array.isArray(m.parts)) return false
    if (m.parts.length === 0) return true
    return m.parts.every((p) => p !== null && typeof p === "object" && (p as { ignored?: unknown }).ignored === true)
}

export function messageHasCompress(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false
    const m = msg as Partial<WithParts>
    if (!m.info || typeof m.info !== "object") return false
    if (m.info.role !== "assistant") return false
    if (!Array.isArray(m.parts)) return false
    return m.parts.some((p) => isCompletedCompressToolPart(p))
}

function isCompletedCompressToolPart(part: unknown): boolean {
    if (!part || typeof part !== "object") return false
    const p = part as Partial<Part>
    if (p.type !== "tool") return false
    const tool = p as Partial<ToolPart>
    if (tool.tool !== "compress") return false
    const state = tool.state as { status?: unknown } | undefined
    return state?.status === "completed"
}

export function getLastUserMessage(
    messages: WithParts[],
    startIndex: number = messages.length - 1,
): WithParts | null {
    if (!Array.isArray(messages)) return null
    const start = Math.min(startIndex, messages.length - 1)
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!msg) continue
        if (msg.info?.role === "user" && !isIgnoredUserMessage(msg) && !isSyntheticMessage(msg)) {
            return msg
        }
    }
    return null
}

export function isSyntheticMessage(message: WithParts): boolean {
    const id = message?.info?.id
    return (
        typeof id === "string" &&
        (id.startsWith("msg_dcp_summary_") || id.startsWith("msg_dcp_text_"))
    )
}

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    if (!message || typeof message !== "object") return false
    if (!message.info || typeof message.info !== "object") return false

    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages === true &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}
