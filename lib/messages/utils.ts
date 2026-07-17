import { createHash } from "node:crypto"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16

/** Tool name used for synthetic compression-recap injection. */
export const ACP_RECAP_TOOL_NAME = "acp_context_recap"

const DCP_BLOCK_ID_TAG_REGEX = /(<(?:dcp|acp)-message-id[^>]*>)b\d+(<\/(?:dcp|acp)-message-id>)/g
// [FIX Bug 28] Regex to strip stale mNNNN refs from compressed summaries
const DCP_MESSAGE_REF_TAG_REGEX = /<(?:dcp|acp)-message-id[^>]*>m\d+<\/(?:dcp|acp)-message-id>/g
const DCP_PAIRED_TAG_REGEX = /<(?:dcp|acp)[^>]*>[\s\S]*?<\/(?:dcp|acp)[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?(?:dcp|acp)[^>]*>/gi

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

export const createSyntheticMessage = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
    role: "user" | "assistant" = "user",
): WithParts => {
    const baseInfo = baseMessage.info
    const now = Date.now()
    const deterministicSeed = stableSeed?.trim() || baseInfo.id
    const messageId = generateStableId("msg_dcp_summary", deterministicSeed)
    const partId = generateStableId("prt_dcp_summary", deterministicSeed)

    const parts = [
        {
            id: partId,
            sessionID: baseInfo.sessionID,
            messageID: messageId,
            type: "text" as const,
            text: content,
            synthetic: true,
        },
    ]

    if (role === "assistant") {
        const isAssistant = baseInfo.role === "assistant"
        const assistantBase = isAssistant ? baseInfo : undefined
        const userModel = !isAssistant ? (baseInfo as UserMessage).model : undefined
        const info: AssistantMessage = {
            id: messageId,
            sessionID: baseInfo.sessionID,
            role: "assistant",
            time: { created: now },
            parentID: assistantBase?.parentID ?? "",
            modelID: assistantBase?.modelID ?? userModel?.modelID ?? "",
            providerID: assistantBase?.providerID ?? userModel?.providerID ?? "",
            mode: assistantBase?.mode ?? "code",
            agent: baseInfo.agent ?? "code",
            path: assistantBase?.path ?? { cwd: "", root: "" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        return { info, parts }
    }

    const userInfo = baseInfo as UserMessage
    const info: UserMessage = {
        id: messageId,
        sessionID: userInfo.sessionID,
        role: "user",
        agent: userInfo.agent,
        model: userInfo.model,
        time: { created: now },
    }
    return { info, parts }
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
): WithParts => createSyntheticMessage(baseMessage, content, stableSeed, "user")

export const createSyntheticToolRecap = (
    baseMessage: WithParts,
    summary: string,
    blockId: number | string,
    messageCount: number | undefined,
    stableSeed: string,
): WithParts => {
    const baseInfo = baseMessage.info
    const now = Date.now()
    const messageId = generateStableId("msg_acp_recap", stableSeed)
    const partId = generateStableId("prt_acp_recap", stableSeed)
    const callId = generateStableId("call_acp_recap", stableSeed)

    const toolPart = {
        id: partId,
        sessionID: baseInfo.sessionID,
        messageID: messageId,
        type: "tool" as const,
        callID: callId,
        tool: ACP_RECAP_TOOL_NAME,
        state: {
            status: "completed" as const,
            input: {
                blockId,
                ...(messageCount !== undefined ? { messages: messageCount } : {}),
            },
            output: summary,
            title: `ACP Context Recap (block ${blockId})`,
            metadata: {},
            time: { start: now, end: now },
        },
    }

    const isAssistant = baseInfo.role === "assistant"
    const assistantBase = isAssistant ? (baseInfo as AssistantMessage) : undefined
    const userModel = !isAssistant ? (baseInfo as UserMessage).model : undefined

    const info: AssistantMessage = {
        id: messageId,
        sessionID: baseInfo.sessionID,
        role: "assistant",
        time: { created: now },
        parentID: assistantBase?.parentID ?? "",
        modelID: assistantBase?.modelID ?? userModel?.modelID ?? "",
        providerID: assistantBase?.providerID ?? userModel?.providerID ?? "",
        mode: assistantBase?.mode ?? "code",
        agent: baseInfo.agent ?? "code",
        path: assistantBase?.path ?? { cwd: "", root: "" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }

    return { info, parts: [toolPart] }
}

export const createSyntheticTextPart = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_text", deterministicSeed)

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>
type TextPart = Extract<MessagePart, { type: "text" }>

export const appendToLastTextPart = (message: WithParts, injection: string): boolean => {
    const textPart = findLastTextPart(message)
    if (!textPart) {
        return false
    }

    return appendToTextPart(textPart, injection)
}

const findLastTextPart = (message: WithParts): TextPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "text") {
            return part
        }
    }

    return null
}

export const appendToTextPart = (part: TextPart, injection: string): boolean => {
    if (typeof part.text !== "string") {
        return false
    }

    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) {
        return false
    }
    if (part.text.includes(normalizedInjection)) {
        return true
    }

    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

export const appendToAllToolParts = (message: WithParts, tag: string): boolean => {
    let injected = false
    for (const part of message.parts) {
        if (part.type === "tool") {
            injected = appendToToolPart(part, tag) || injected
        }
    }
    return injected
}

const appendToToolPart = (part: ToolPart, tag: string): boolean => {
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    if (part.state.output.includes(tag)) {
        return true
    }

    part.state.output = `${part.state.output}${tag}`
    return true
}

export const hasContent = (message: WithParts): boolean => {
    return message.parts.some(
        (part) =>
            (part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0) ||
            (part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"),
    )
}

export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
    const toolIds: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length > 0) {
            for (const part of parts) {
                if (part.type === "tool" && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }
    state.toolIdList = toolIds
    return toolIds
}

export const replaceBlockIdsWithBlocked = (text: string): string => {
    return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2")
}

// [FIX Bug 28] Strip stale mNNNN refs from compressed summaries before injection
export const stripStaleMessageRefs = (text: string): string => {
    return text.replace(DCP_MESSAGE_REF_TAG_REGEX, "")
}

export const stripHallucinationsFromString = (text: string): string => {
    return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[]): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output)
            }
        }
    }
}

// [FIX #12] Backstop: sweep empty messages of ANY role (in-place, backwards).
// A message is considered empty only when every part is a whitespace-only text
// part (or there are no parts at all). Any non-text part — a tool call regardless
// of status, reasoning, etc. — counts as meaningful content and prevents removal.
// This is deliberately more conservative than hasContent(): hasContent treats a
// non-completed/errored tool as "no content" (appropriate for suffix-fill logic),
// but here we must not drop a message that carries an errored or in-flight tool call.
export const dropEmptyMessages = (messages: WithParts[]): number => {
    let removed = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const parts = Array.isArray(messages[i].parts) ? messages[i].parts : []
        const isEmpty = parts.every(
            (part) =>
                part.type === "text" &&
                (typeof part.text !== "string" || part.text.trim().length === 0),
        )
        if (isEmpty) {
            messages.splice(i, 1)
            removed++
        }
    }
    return removed
}
