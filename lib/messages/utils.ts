import { createHash } from "node:crypto"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16

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

// [#431] Strip a leaked bare ACP reference fragment from completed assistant text.
//
// The model occasionally degenerates at the end of a completion and echoes the
// ID-annotation pattern it saw on the last visible message as a bare token
// followed by unrelated garbage:
//
//     Normal progress message.
//     m00057 <random multilingual tail>
//
// stripHallucinationsFromString cannot see this — the fragment carries no tag.
//
// Key invariant exploited here: message refs and block IDs are allocated
// strictly monotonically (`messageIds.nextRef` / `prune.messages.nextBlockId`
// are the next values to be allocated; nothing at or beyond them exists yet).
// And the completing message does NOT have its ref assigned yet — assignment
// happens on the next messages.transform. So a ref at or beyond the
// next-to-allocate value cannot be a legitimate citation of anything the model
// could have seen; it is by definition a hallucinated/future ID.
//
// Conservative guards (legitimate prose must survive):
// - LINE-LEADING only: the ref must start a line (string start or after \n,
//   optional leading [ \t]). Embedded mentions ("see m00042") are untouched.
// - Exact injected format only: lowercase `m` + 4-5 digits, or lowercase `b` +
//   non-zero digits. Uppercase forms (product codes like "M00057") do not match.
// - Only future values are cut. Existing refs (below the bound) are always kept.
// - Unknown ID space (both bounds invalid) → input returned unchanged.
// Truncation removes from the first qualifying line-leading ref to end of
// string, then trims trailing whitespace.
const LEAKED_TRAILING_REF_REGEX = /(?:^|\n)[ \t]*(?:m(\d{4,5})|b([1-9]\d*))\b/g

export const stripLeakedTrailingRefs = (
    text: string,
    bounds: { nextMessageRef?: number | null; nextBlockRef?: number | null },
): string => {
    if (typeof text !== "string" || text.length === 0) {
        return text
    }

    const hasMessageBound =
        typeof bounds.nextMessageRef === "number" && Number.isInteger(bounds.nextMessageRef)
    const hasBlockBound =
        typeof bounds.nextBlockRef === "number" && Number.isInteger(bounds.nextBlockRef)
    if (!hasMessageBound && !hasBlockBound) {
        return text
    }

    // Rebuilt per call: global regexes carry mutable lastIndex state.
    const pattern = new RegExp(LEAKED_TRAILING_REF_REGEX.source, "g")
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
        if (match[1] !== undefined) {
            if (hasMessageBound && Number(match[1]) >= bounds.nextMessageRef!) {
                return text.slice(0, match.index).replace(/[ \t\r\n]*$/, "")
            }
        } else if (match[2] !== undefined) {
            if (hasBlockBound && Number(match[2]) >= bounds.nextBlockRef!) {
                return text.slice(0, match.index).replace(/[ \t\r\n]*$/, "")
            }
        }
    }
    return text
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
//
// [FIX #20] A text part carrying `ignored: true` also counts as discardable.
// opencode strips ignored parts before the LLM call; a message whose only part
// is ignored would arrive at the provider as an empty user message and trigger
// HTTP 400 (zhipuai code 1214, isRetryable: false). Treating ignored parts as
// empty here drops those messages before they can do damage.
export const dropEmptyMessages = (messages: WithParts[]): number => {
    let removed = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const parts = Array.isArray(messages[i].parts) ? messages[i].parts : []
        const isEmpty = parts.every(
            (part) =>
                part.type === "text" &&
                ((typeof part.text !== "string" || part.text.trim().length === 0) ||
                    (part as { ignored?: boolean }).ignored === true),
        )
        if (isEmpty) {
            messages.splice(i, 1)
            removed++
        }
    }
    return removed
}
