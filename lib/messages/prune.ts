import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import { isCompacted } from "../state/queries"
import {
    stripStaleMessageRefs,
    prependCompressionSummary,
    createSyntheticUserMessage,
    replaceBlockIdsWithBlocked,
} from "./utils"
import { getLastUserMessage } from "./query"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export function prune(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void {
    filterCompressedRanges(state, logger, config, messages)
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
    pruneToolErrors(state, logger, messages)
}

function pruneToolOutputs(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void {
    for (const msg of messages) {
        if (isCompacted(state, msg)) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue
            const toolPart = part as {
                type: "tool"
                tool: string
                callID: string
                state: { status: string; output?: string }
            }

            if (!state.prune.tools.has(toolPart.callID)) continue
            if (toolPart.state.status !== "completed") continue
            if (toolPart.tool === "question" || toolPart.tool === "edit" || toolPart.tool === "write") continue

            toolPart.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
        }
    }
}

function pruneToolInputs(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void {
    for (const msg of messages) {
        if (isCompacted(state, msg)) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue
            const toolPart = part as {
                type: "tool"
                tool: string
                callID: string
                state: { status: string; input?: { questions?: unknown } }
            }

            if (!state.prune.tools.has(toolPart.callID)) continue
            if (toolPart.state.status !== "completed") continue
            if (toolPart.tool !== "question") continue

            if (toolPart.state.input?.questions !== undefined) {
                toolPart.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
            }
        }
    }
}

function pruneToolErrors(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void {
    for (const msg of messages) {
        if (isCompacted(state, msg)) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue
            const toolPart = part as {
                type: "tool"
                callID: string
                state: { status: string; input?: Record<string, unknown> }
            }

            if (!state.prune.tools.has(toolPart.callID)) continue
            if (toolPart.state.status !== "error") continue

            const input = toolPart.state.input
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

function filterCompressedRanges(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void {
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

        const blockId = state.prune.messages.activeByAnchorMessageId.get(msgId)
        const block = blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined

        if (block) {
            if (block.active !== true || typeof block.summary !== "string" || block.summary.length === 0) {
                logger.warn("Skipping malformed compress summary", { anchorMessageId: msgId })
            } else {
                const cleaned = stripStaleMessageRefs(block.summary)
                const summaryContent =
                    config.compress.mode === "message"
                        ? replaceBlockIdsWithBlocked(cleaned)
                        : cleaned

                const nextSurviving = findNextSurvivingMessage(messages, i, state)
                const merged =
                    nextSurviving !== null &&
                    nextSurviving.info.role === "user" &&
                    prependCompressionSummary(nextSurviving, summaryContent, block.blockId)

                if (merged) {
                    logger.info("Merged compress summary into user message", {
                        anchorMessageId: msgId,
                        targetMessageId: nextSurviving!.info.id,
                    })
                } else {
                    const userMessage = getLastUserMessage(messages, i)
                    const summarySeed = `${block.blockId}:${block.anchorMessageId}`
                    if (userMessage) {
                        result.push(createSyntheticUserMessage(userMessage, summaryContent, summarySeed))
                    } else {
                        const fallbackBase: WithParts = {
                            info: {
                                id: msg.info.id,
                                sessionID: msg.info.sessionID,
                                role: "user",
                                agent: msg.info.agent,
                                model: "model" in msg.info ? msg.info.model : { providerID: "", modelID: "" },
                                time: { created: msg.info.time.created },
                            } as WithParts["info"],
                            parts: [],
                        }
                        result.push(createSyntheticUserMessage(fallbackBase, summaryContent, summarySeed))
                    }
                }
            }
        }

        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        result.push(msg)
    }

    messages.length = 0
    messages.push(...result)
}

function findNextSurvivingMessage(
    messages: WithParts[],
    startIndex: number,
    state: SessionState,
): WithParts | null {
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
