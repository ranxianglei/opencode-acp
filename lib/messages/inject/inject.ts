import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import {
    getLastUserMessage,
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompress,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    createSyntheticUserMessage,
    hasContent,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    buildContextUsageGuidance,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
} from "./utils"
import { buildCompressedBlockGuidance } from "../../prompts/extensions/nudge"

/**
 * Stable seed for the ACP dynamic guidance suffix message.
 * Using a fixed seed ensures the synthetic message ID is deterministic,
 * so it won't be assigned a new mNNNNN ref on each transform call.
 */
const ACP_SUFFIX_SEED = "acp-dynamic-guidance"

/**
 * Create a synthetic user message at the END of the messages array.
 * All per-turn dynamic ACP content (context usage, visible IDs, nudges, etc.)
 * is injected into this suffix message instead of historical user messages,
 * preserving OpenAI Responses prefix cache stability.
 */
function createSuffixMessage(messages: WithParts[]): WithParts | null {
    if (messages.length === 0) return null
    // Use any user message as base for session/agent/model info
    const base = messages.find((m) => m.info.role === "user") || messages[messages.length - 1]
    const synthetic = createSyntheticUserMessage(base, "", ACP_SUFFIX_SEED)
    messages.push(synthetic)
    return synthetic
}

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    if (state.manualMode) {
        return
    }

    const lastMessage = findLastNonIgnoredMessage(messages)
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")

    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        void saveSessionState(state, logger)
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    const { overMaxLimit, overMinLimit, currentTokens, modelContextLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (!overMinLimit) {
        const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
        const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0

        if (hadTurnAnchors || hadIterationAnchors) {
            state.nudges.turnNudgeAnchors.clear()
            state.nudges.iterationNudgeAnchors.clear()
            anchorsChanged = true
        }
    }

    if (overMaxLimit) {
        if (lastMessage) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.contextLimitAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }
    } else if (overMinLimit) {
        const isLastMessageUser = lastMessage?.message.info.role === "user"

        if (isLastMessageUser && lastAssistantMessage) {
            const previousSize = state.nudges.turnNudgeAnchors.size
            state.nudges.turnNudgeAnchors.add(lastMessage.message.info.id)
            state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
            if (state.nudges.turnNudgeAnchors.size !== previousSize) {
                anchorsChanged = true
            }
        }

        const lastUserMessage = getLastUserMessage(messages)
        if (lastUserMessage && lastMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            if (lastUserMessageIndex >= 0) {
                const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
                const iterationThreshold = getIterationNudgeThreshold(config)

                if (
                    lastMessage.index > lastUserMessageIndex &&
                    messagesSinceUser >= iterationThreshold
                ) {
                    const interval = getNudgeFrequency(config)
                    const added = addAnchor(
                        state.nudges.iterationNudgeAnchors,
                        lastMessage.message.info.id,
                        lastMessage.index,
                        messages,
                        interval,
                    )

                    if (added) {
                        anchorsChanged = true
                    }
                }
            }
        }
    }

    const suffixMessage = createSuffixMessage(messages)

    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities, currentTokens, modelContextLimit, suffixMessage)

    injectContextUsage(suffixMessage, config, currentTokens, modelContextLimit)

    if (config.compress.mode !== "message") {
        const blockGuidance = buildCompressedBlockGuidance(state, config.gc, { currentTokens, modelContextLimit })
        if (blockGuidance.trim() && suffixMessage) {
            appendToLastTextPart(suffixMessage, "\n\n" + blockGuidance)
        }
    }

    injectVisibleIdRange(state, messages, suffixMessage)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

function injectContextUsage(
    target: WithParts | null,
    config: PluginConfig,
    currentTokens?: number,
    modelContextLimit?: number,
): void {
    if (!target) return
    const usageTag = buildContextUsageGuidance(config, currentTokens, modelContextLimit)
    if (!usageTag) return

    for (const part of target.parts) {
        if (part.type === "text") {
            appendToTextPart(part, usageTag)
            return
        }
    }
    target.parts.push(createSyntheticTextPart(target, usageTag))
}

function injectVisibleIdRange(state: SessionState, messages: WithParts[], target: WithParts | null): void {
    if (!target) return
    const visibleRefs: string[] = []
    for (const message of messages) {
        const ref = state.messageIds.byRawId.get(message.info.id)
        if (ref) {
            visibleRefs.push(ref)
        }
    }

    if (visibleRefs.length === 0) return

    visibleRefs.sort()
    const first = visibleRefs[0]
    const last = visibleRefs[visibleRefs.length - 1]
    const rangeTag = `\n\n[Visible message IDs: ${first} to ${last} (${visibleRefs.length} messages). Only use IDs in this range for compress.]`

    for (const part of target.parts) {
        if (part.type === "text") {
            appendToTextPart(part, rangeTag)
            return
        }
    }
    target.parts.push(createSyntheticTextPart(target, rangeTag))
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
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

        const isBlockedMessage = isProtectedUserMessage(config, message)
        const priority =
            config.compress.mode === "message" && !isBlockedMessage
                ? compressionPriorities?.get(message.info.id)?.priority
                : undefined
        const tag = formatMessageIdTag(
            isBlockedMessage ? "BLOCKED" : messageRef,
            priority ? { priority } : undefined,
        )

        if (message.info.role === "user") {
            let injected = false
            for (const part of message.parts) {
                if (part.type === "text") {
                    injected = appendToTextPart(part, tag) || injected
                }
            }

            if (injected) {
                continue
            }

            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        if (appendToAllToolParts(message, tag)) {
            continue
        }

        if (appendToLastTextPart(message, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}
