import type { PluginConfig } from "../../config/types"
import type { SessionState, WithParts } from "../../state/types"
import type { Logger } from "../../infra/logger"
import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { formatMessageRef } from "../../infra/message-refs"
import { appendToLastTextPart } from "../utils"
import { getLastUserMessage, isIgnoredUserMessage, messageHasCompress } from "../query"
import {
    shouldNudgeContextLimit,
    shouldNudgeTurn,
    shouldNudgeIteration,
    renderContextLimitNudge,
    renderTurnNudge,
    renderIterationNudge,
    type NudgeContext,
} from "../../prompts/nudges"
import {
    computeContextUsage,
    getMessagesSinceLastUser,
    shouldShowBlockAgingWarning,
} from "./utils"

export function injectMessageIds(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    _compressionPriorities?: any,
): void {
    if (config.compress.permission === "deny") {
        return
    }

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const isBlockedMessage =
            message.info.role === "user" && config.compress.protectUserMessages === true

        const tag = formatMessageIdTagWithAttr(
            isBlockedMessage ? "BLOCKED" : messageRef,
        )

        injectTagIntoMessage(message, tag)
    }
}

function formatMessageIdTagWithAttr(ref: string): string {
    return `\n<dcp-message-id>${ref}</dcp-message-id>`
}

function getOrCreateRef(state: SessionState, rawId: string): string {
    const existing = state.messageIds.byRawId.get(rawId)
    if (existing) return existing
    const ref = formatMessageRef(state.messageIds.nextRef)
    state.messageIds.nextRef += 1
    state.messageIds.byRawId.set(rawId, ref)
    state.messageIds.byRef.set(ref, rawId)
    return ref
}

function isProtectedMessage(msg: WithParts, config: PluginConfig): boolean {
    if (msg.info.role === "user" && config.compress.protectUserMessages) return true
    return false
}

function injectTagIntoMessage(msg: WithParts, tag: string): void {
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
        if (msg.info.role === "user" || msg.info.role === "assistant") {
            msg.parts.push({
                id: `${msg.info.id}-synthetic`,
                messageID: msg.info.id,
                sessionID: (msg.info as any).sessionID ?? "",
                type: "text",
                text: tag,
            } as any)
        }
        return
    }

    if (msg.info.role === "user") {
        let injected = false
        for (const part of msg.parts) {
            if (part && part.type === "text") {
                appendTagToTextPart(part as TextPart, tag)
                injected = true
            }
        }
        if (!injected) {
            msg.parts.push({
                id: `${msg.info.id}-synthetic`,
                messageID: msg.info.id,
                sessionID: (msg.info as any).sessionID ?? "",
                type: "text",
                text: tag,
            } as any)
        }
        return
    }

    if (msg.info.role === "assistant") {
        let injected = false
        for (const part of msg.parts) {
            if (!part || part.type !== "tool") continue
            const toolPart = part as ToolPart
            const state = toolPart.state as { output?: unknown } | undefined
            if (state && typeof state.output === "string") {
                state.output = `${state.output}\n\n${tag}`
                injected = true
            }
        }
        if (injected) return

        for (const part of msg.parts) {
            if (part && part.type === "text") {
                appendTagToTextPart(part as TextPart, tag)
                return
            }
        }

        msg.parts.push({
            id: `${msg.info.id}-synthetic`,
            messageID: msg.info.id,
            sessionID: (msg.info as any).sessionID ?? "",
            type: "text",
            text: tag,
        } as any)
    }
}

function appendTagToTextPart(part: TextPart, tag: string): void {
    part.text = `${part.text ?? ""}\n\n${tag}`
}

export function injectCompressNudges(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    _prompts?: any,
    _compressionPriorities?: any,
): void {
    if (config.compress.permission === "deny") return

    if (state.manualMode) {
        return
    }

    const lastAssistantMessage = messages.findLast?.((message: WithParts) => message.info.role === "assistant")
    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        ;(state.nudges as any).turnNudgeAnchors?.clear?.()
        ;(state.nudges as any).iterationNudgeAnchors?.clear?.()
        return
    }

    const contextUsagePercent = computeContextUsage(state, messages)
    const ctx = buildNudgeContext(state, config, messages, contextUsagePercent)

    if (shouldNudgeContextLimit(ctx)) {
        anchorLastUser((state.nudges as any).contextLimitAnchors ?? state.nudges.contextLimitAnchors, messages, logger)
    }

    if (shouldNudgeTurn(ctx)) {
        anchorLastUser((state.nudges as any).turnNudgeAnchors ?? new Set(), messages, logger)
    }

    if (shouldNudgeIteration(ctx, config.compress.iterationNudgeThreshold)) {
        anchorLastMessage((state.nudges as any).iterationNudgeAnchors ?? new Set(), messages, logger)
    }
}

function buildNudgeContext(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    contextUsagePercent: number,
): NudgeContext {
    return {
        contextUsagePercent,
        messagesSinceLastUser: getMessagesSinceLastUser(messages),
        currentTurn: state.currentTurn,
        lastNudgeTurn: state.nudges.lastNudgeTurn,
        nudgeFrequency: config.compress.nudgeFrequency,
        force: config.compress.nudgeForce,
    }
}

function anchorLastUser(
    anchors: Set<string>,
    messages: WithParts[],
    logger: Logger,
): void {
    const last = getLastUserMessage(messages)
    if (!last) {
        logger.debug("injectCompressNudges: no user message to anchor nudge")
        return
    }
    anchors.add(last.info.id)
}

function anchorLastMessage(
    anchors: Set<string>,
    messages: WithParts[],
    logger: Logger,
): void {
    if (!Array.isArray(messages) || messages.length === 0) {
        logger.debug("injectCompressNudges: no message to anchor iteration nudge")
        return
    }
    const last = messages[messages.length - 1]
    if (last && last.info && typeof last.info.id === "string") {
        anchors.add(last.info.id)
    }
}

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    const anchors = state.nudges
    if (
        anchors.contextLimitAnchors.size === 0 &&
        anchors.turnAnchors.size === 0 &&
        anchors.iterationAnchors.size === 0
    ) {
        return
    }

    const contextUsagePercent = computeContextUsage(state, messages)
    const ctx = buildNudgeContext(state, config, messages, contextUsagePercent)
    let appliedTurn = false

    for (const msg of messages) {
        const id = msg.info?.id
        if (typeof id !== "string" || id === "") continue

        const fragments: string[] = []

        if (anchors.contextLimitAnchors.has(id)) {
            fragments.push(renderContextLimitNudge(ctx))
        }
        if (anchors.turnAnchors.has(id)) {
            fragments.push(renderTurnNudge(ctx))
            appliedTurn = true
        }
        if (anchors.iterationAnchors.has(id)) {
            fragments.push(renderIterationNudge(ctx))
        }

        if (fragments.length === 0) continue
        if (!canReceiveNudge(msg)) continue

        const text = fragments
            .map((f) => `<dcp-system-reminder>\n${f}\n</dcp-system-reminder>`)
            .join("\n\n")
        appendToLastTextPart(msg, `\n\n${text}`)
    }

    if (appliedTurn) {
        state.nudges.lastNudgeTurn = state.currentTurn
    }

    anchors.contextLimitAnchors.clear()
    anchors.turnAnchors.clear()
    anchors.iterationAnchors.clear()

    if (shouldShowBlockAgingWarning(state, config, contextUsagePercent)) {
        logger.debug("applyAnchoredNudges: block aging conditions met", {
            contextUsagePercent,
        })
    }
}

// Issue #463: never inject into empty/pending assistant turns — appending text
// would create a prefill that biases the model's next generation.
function canReceiveNudge(msg: WithParts): boolean {
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) return false

    if (msg.info.role === "assistant") {
        for (const part of msg.parts) {
            if (!part) continue
            if (part.type === "text") {
                if ((part as TextPart).text !== "") return true
                continue
            }
            if (part.type === "tool") {
                const status = (part as ToolPart).state?.status
                if (status !== "pending" && status !== "running") return true
            }
        }
        return false
    }

    return true
}

export function assignMessageRefs(
    state: SessionState,
    messages: WithParts[],
): number {
    let assigned = 0
    let skippedSubAgentPrompt = false

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }
        if (rawMessageId.startsWith("msg_dcp_summary_") || rawMessageId.startsWith("msg_dcp_text_")) {
            continue
        }

        const existingRef = state.messageIds.byRawId.get(rawMessageId)
        if (existingRef) {
            if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
                state.messageIds.byRef.set(existingRef, rawMessageId)
            }
            continue
        }

        const ref = allocateNextMessageRef(state)
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
        assigned++
    }

    return assigned
}

const MESSAGE_REF_MIN_INDEX = 1
const MESSAGE_REF_MAX_INDEX = 99999

function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    while (candidate <= MESSAGE_REF_MAX_INDEX) {
        const ref = formatMessageRef(candidate)
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1
            return ref
        }
        candidate++
    }

    throw new Error(
        `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`,
    )
}
