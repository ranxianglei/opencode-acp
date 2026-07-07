import { createHash } from "node:crypto"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16

// [FIX Bug 36] Delimiters wrapping a compression summary when it is merged into
// an existing user message. The header embeds the block id so multiple blocks
// landing on the same user message each get their own clearly delimited entry,
// and so the prepend is idempotent across re-runs (guarded by the marker check).
// [FIX Bug 37] Tagged as system metadata (not user content) so the model does
// not misattribute the assistant's prior compression summary as a user turn.
const MERGED_SUMMARY_HEADER = (blockId: number | string) =>
    `<acp-compression-summary>\n[ACP model-generated recap (block ${blockId}) — NOT a user message]\n`
const MERGED_SUMMARY_FOOTER = `\n</acp-compression-summary>\n\n`
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/(?:dcp|acp)-message-id>)/g
// [FIX Bug 28] Regex to strip stale mNNNN refs from compressed summaries
const DCP_MESSAGE_REF_TAG_REGEX = /<dcp-message-id>m\d+<\/(?:dcp|acp)-message-id>/g
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/(?:dcp|acp)[^>]*>/gi
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

// [FIX Bug 36] Merge a compression summary into an existing user message by
// prepending it (clearly delimited) to that message's first text part. This
// avoids emitting a standalone user-role summary message adjacent to the user's
// real turn, which previously produced two consecutive user messages and caused
// dialog role confusion / "self-Q&A" loops. Returns true when the summary is
// present after the call — including the idempotent case where the block's
// marker is already in the text (no-op), matching appendToTextPart so callers
// never fall through to a standalone message merely because of a re-run.
export const prependCompressionSummary = (
    message: WithParts,
    summary: string,
    blockId: number | string,
): boolean => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const header = MERGED_SUMMARY_HEADER(blockId)
    const marker = MERGED_SUMMARY_HEADER(blockId).trimEnd()

    for (const part of parts) {
        if (part.type !== "text") {
            continue
        }
        const textPart = part as TextPart
        const existing = typeof textPart.text === "string" ? textPart.text : ""
        if (existing.includes(marker)) {
            return true
        }
        textPart.text = `${header}${summary}${MERGED_SUMMARY_FOOTER}${existing}`
        return true
    }

    const sessionID = (message.info as { sessionID?: string }).sessionID ?? ""
    const messageId = (message.info as { id: string }).id
    parts.unshift({
        id: generateStableId("prt_dcp_prepend", `${blockId}:${messageId}`),
        sessionID,
        messageID: messageId,
        type: "text" as const,
        text: `${header}${summary}${MERGED_SUMMARY_FOOTER}`,
    })
    message.parts = parts
    return true
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
