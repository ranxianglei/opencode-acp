import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import type { Message, Part, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { countTokensSync } from "../infra/token-counter"

const PAIRED_DCP_TAG = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/g
const ORPHAN_OPEN_DCP_TAG = /<dcp[^>]*>/g
const ORPHAN_CLOSE_DCP_TAG = /<\/dcp[^>]*>/g
const ANY_MESSAGE_ID_TAG = /<dcp-message-id[^>]*>[\s\S]*?<\/dcp-message-id>/g
const ORPHAN_MESSAGE_ID_TAG = /<\/?dcp-message-id[^>]*>/g
const BLOCK_REF_IN_TAG = /<dcp-message-id>b\d+<\/dcp-message-id>/g

export function stripHallucinationsFromString(text: string): string {
    if (typeof text !== "string" || text === "") return text ?? ""
    let result = text.replace(PAIRED_DCP_TAG, "")
    result = result.replace(ORPHAN_OPEN_DCP_TAG, "")
    result = result.replace(ORPHAN_CLOSE_DCP_TAG, "")
    return result
}

export function stripStaleMessageRefs(text: string): string {
    if (typeof text !== "string" || text === "") return text ?? ""
    let result = text.replace(ANY_MESSAGE_ID_TAG, "")
    result = result.replace(ORPHAN_MESSAGE_ID_TAG, "")
    return result
}

export function replaceBlockIdsWithBlocked(text: string): string {
    if (typeof text !== "string" || text === "") return text ?? ""
    return text.replace(BLOCK_REF_IN_TAG, "<dcp-message-id>BLOCKED</dcp-message-id>")
}

export function stripHallucinations(messages: WithParts[]): void {
    if (!Array.isArray(messages)) return
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.parts)) continue
        for (const rawPart of msg.parts) {
            if (!rawPart) continue
            stripPart(rawPart)
        }
    }
}

function stripPart(part: Part): void {
    if (part.type === "text") {
        const textPart = part as TextPart
        textPart.text = stripHallucinationsFromString(textPart.text)
        return
    }
    if (part.type === "tool") {
        const toolPart = part as ToolPart
        const state = toolPart.state as { status?: string; output?: unknown }
        if (state && typeof state.output === "string") {
            state.output = stripHallucinationsFromString(state.output)
        }
    }
}

export function appendToLastTextPart(msg: WithParts, text: string): boolean {
    if (!msg || !Array.isArray(msg.parts)) return false
    for (let i = msg.parts.length - 1; i >= 0; i--) {
        const part = msg.parts[i]
        if (part && part.type === "text") {
            const textPart = part as TextPart
            textPart.text = (textPart.text ?? "") + text
            return true
        }
    }
    return false
}

export function prependCompressionSummary(
    msg: WithParts,
    summary: string,
    _blockId?: number,
): boolean {
    if (!msg || !msg.info) return false
    if (msg.info.role !== "user") return false
    if (!Array.isArray(msg.parts)) return false
    for (const part of msg.parts) {
        if (part && part.type === "text") {
            const textPart = part as TextPart
            textPart.text = summary + (textPart.text ?? "")
            return true
        }
    }
    return false
}

export function createSyntheticUserMessage(
    base: WithParts,
    summary: string,
    seed: string | number,
): WithParts {
    const baseInfo = base.info as Message
    const sessionID = baseInfo.sessionID ?? ""
    const agent = (baseInfo as { agent?: string }).agent ?? "assistant"
    const baseCreated = (baseInfo as { time?: { created?: number } }).time?.created ?? Date.now()
    const id = `${baseInfo.id ?? "msg"}-summary-${seed}`
    const model = resolveUserModel(baseInfo)

    const info: UserMessage = {
        id,
        sessionID,
        role: "user",
        time: { created: baseCreated },
        agent,
        model,
    }

    const summaryPart: TextPart = {
        id: `${id}-part`,
        sessionID,
        messageID: id,
        type: "text",
        text: summary,
        synthetic: true,
    }

    return { info, parts: [summaryPart] }
}

function resolveUserModel(info: Message): { providerID: string; modelID: string } {
    if (info.role === "user") {
        return {
            providerID: info.model.providerID ?? "",
            modelID: info.model.modelID ?? "",
        }
    }
    const assistant = info as Partial<{ modelID: string; providerID: string }>
    return {
        providerID: assistant.providerID ?? "",
        modelID: assistant.modelID ?? "",
    }
}

export function computeInputBudget(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
): number {
    const maxLimit = resolveContextLimit(config, state)
    if (maxLimit <= 0) return 0
    const used = estimateMessagesTokens(messages)
    return Math.max(0, maxLimit - used)
}

function resolveContextLimit(config: PluginConfig, state: SessionState): number {
    const raw = config.compress.maxContextLimit
    const windowLimit = state.modelContextLimit
    if (typeof raw === "number") return raw
    if (typeof raw === "string" && raw.endsWith("%")) {
        const pct = parseFloat(raw.slice(0, -1))
        if (!isNaN(pct) && windowLimit && windowLimit > 0) {
            return Math.floor((windowLimit * pct) / 100)
        }
    }
    return typeof raw === "number" ? raw : 0
}

function estimateMessagesTokens(messages: WithParts[]): number {
    if (!Array.isArray(messages)) return 0
    let total = 0
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.parts)) continue
        for (const part of msg.parts) {
            if (!part) continue
            const p = part as { type?: string; text?: unknown; state?: { output?: unknown } }
            if (typeof p.text === "string") total += countTokensSync(p.text)
            if (p.type === "tool" && p.state && typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
        }
    }
    return total
}

export function appendToTextPart(part: Part, text: string): boolean {
    if (!part || part.type !== "text") return false
    const textPart = part as TextPart
    textPart.text = (textPart.text ?? "") + text
    return true
}

export function createSyntheticTextPart(message: WithParts, text: string): TextPart {
    const info = message.info as Message
    const sessionID = info.sessionID ?? ""
    const messageId = info.id ?? ""
    return {
        id: `${messageId}-part-${Math.random().toString(36).slice(2, 8)}`,
        sessionID,
        messageID: messageId,
        type: "text",
        text,
        synthetic: true,
    }
}

export function hasContent(message: WithParts): boolean {
    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
        return false
    }
    for (const part of message.parts) {
        if (!part) continue
        if (part.type === "text") {
            const text = (part as TextPart).text
            if (typeof text === "string" && text.length > 0) return true
            continue
        }
        if (part.type === "tool") return true
    }
    return false
}
