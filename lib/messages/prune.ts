import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../state/utils"
import { createSyntheticUserMessage, prependCompressionSummary, replaceBlockIdsWithBlocked, stripStaleMessageRefs } from "./utils"
import { getLastUserMessage } from "./query"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, logger, config, messages)
    // [HOTFIX] Disabled pruneToolOutputs/pruneToolInputs/pruneToolErrors — they mutate
    // existing messages in-place, breaking GLM prefix cache. Compression still works
    // via filterCompressedRanges + model-initiated compress tool.
    // pruneToolOutputs(state, logger, messages)
    // pruneToolInputs(state, logger, messages)
    // pruneToolErrors(state, logger, messages)
}

const pruneFullTool = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    const messagesToRemove: string[] = []

    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const partsToRemove: string[] = []

        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }

            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.tool !== "edit" && part.tool !== "write") {
                continue
            }

            partsToRemove.push(part.callID)
        }

        if (partsToRemove.length === 0) {
            continue
        }

        msg.parts = parts.filter(
            (part) => part.type !== "tool" || !partsToRemove.includes(part.callID),
        )

        if (msg.parts.length === 0) {
            messagesToRemove.push(msg.info.id)
        }
    }

    if (messagesToRemove.length > 0) {
        const result = messages.filter((msg) => !messagesToRemove.includes(msg.info.id))
        messages.length = 0
        messages.push(...result)
    }
}

const pruneToolOutputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
                continue
            }

            part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
        }
    }
}

const pruneToolInputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }

            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool !== "question") {
                continue
            }

            if (part.state.input?.questions !== undefined) {
                part.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolErrors = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "error") {
                continue
            }

            // Prune all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (
        state.prune.messages.byMessageId.size === 0 &&
        state.prune.messages.activeByAnchorMessageId.size === 0
    ) {
        return
    }

    const result: WithParts[] = []

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        const msgId = msg.info.id

        // Check if there's a summary to inject at this anchor point
        const blockId = state.prune.messages.activeByAnchorMessageId.get(msgId)
        const summary =
            blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined
        if (summary) {
            const rawSummaryContent = (summary as { summary?: unknown }).summary
            if (
                summary.active !== true ||
                typeof rawSummaryContent !== "string" ||
                rawSummaryContent.length === 0
            ) {
                logger.warn("Skipping malformed compress summary", {
                    anchorMessageId: msgId,
                    blockId: (summary as { blockId?: unknown }).blockId,
                })
            } else {
                // [FIX Bug 28] Strip stale mNNNN refs before injection
                const _cleaned = stripStaleMessageRefs(rawSummaryContent)
                const summaryContent =
                    config.compress.mode === "message"
                        ? replaceBlockIdsWithBlocked(_cleaned)
                        : _cleaned

                // [FIX Bug 36] When the next surviving message is a user turn, merge the
                // summary into it instead of emitting a standalone user-role summary
                // message. The old behavior placed a synthetic user message immediately
                // before the user's real turn ([summary(user), user(user)]), which the
                // model often read as two user turns — misattributing the assistant's
                // prior output to the user and triggering "self-Q&A" loops. Merging
                // yields a single user turn ([user: recap ‖ real reply]) so no fake
                // conversational turn is perceived.
                const nextSurviving = findNextSurvivingMessage(messages, i, state)
                const merged =
                    nextSurviving !== null &&
                    nextSurviving.info.role === "user" &&
                    prependCompressionSummary(nextSurviving, summaryContent, summary.blockId)

                if (merged) {
                    logger.info("Merged compress summary into following user message", {
                        anchorMessageId: msgId,
                        targetMessageId: nextSurviving!.info.id,
                        summaryLength: summaryContent.length,
                    })
                } else {
                    // [FIX Bug 1] fallback when no suitable user message to merge into:
                    // emit a standalone synthetic user message (prior behavior).
                    const userMessage = getLastUserMessage(messages, i)
                    const summarySeed = `${summary.blockId}:${summary.anchorMessageId}`
                    if (userMessage) {
                        result.push(
                            createSyntheticUserMessage(userMessage, summaryContent, summarySeed),
                        )

                        logger.info("Injected compress summary", {
                            anchorMessageId: msgId,
                            summaryLength: summaryContent.length,
                        })
                    } else {
                        const anchorInfo = msg.info as any
                        const fallbackBase: WithParts = {
                            info: {
                                id: anchorInfo.id || msgId,
                                sessionID: anchorInfo.sessionID || "",
                                role: "user" as const,
                                agent: anchorInfo.agent || "code",
                                model:
                                    anchorInfo.model || {
                                        providerID: "",
                                        modelID: "",
                                        variant: undefined,
                                    },
                                time: { created: anchorInfo.time?.created || Date.now() },
                            },
                            parts: [],
                        }
                        result.push(
                            createSyntheticUserMessage(fallbackBase, summaryContent, summarySeed),
                        )

                        logger.info("Injected compress summary (fallback, no preceding user message)", {
                            anchorMessageId: msgId,
                            summaryLength: summaryContent.length,
                        })
                    }
                }
            }
        }

        // Skip messages that are in the prune list
        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        // Normal message, include it
        result.push(msg)
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}

// [FIX Bug 36] First surviving (non-pruned) message at or after startIndex.
// Starts the scan at startIndex inclusive to handle both anchor layouts: when
// the anchor is itself part of the pruned range (message-start ranges) it is
// skipped, and when the anchor survives (block-anchor ranges) it is returned —
// in either case this yields the next real turn the model sees after the recap.
const findNextSurvivingMessage = (
    messages: WithParts[],
    startIndex: number,
    state: SessionState,
): WithParts | null => {
    for (let j = startIndex; j < messages.length; j++) {
        const candidate = messages[j]!
        const entry = state.prune.messages.byMessageId.get(candidate.info.id)
        if (entry && entry.activeBlockIds.length > 0) {
            continue
        }
        return candidate
    }
    return null
}
