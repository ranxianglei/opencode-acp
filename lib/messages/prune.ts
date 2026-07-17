import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../state/utils"

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
    filterCompressedRanges(state, messages)
    stripStepMarkers(messages)
    // [HOTFIX] Disabled pruneToolOutputs/pruneToolInputs/pruneToolErrors — they mutate
    // existing messages in-place, breaking GLM prefix cache. Compression still works
    // via filterCompressedRanges + model-initiated compress tool.
    // pruneToolOutputs(state, logger, messages)
    // pruneToolInputs(state, logger, messages)
    // pruneToolErrors(state, logger, messages)
}

const MAX_STEP_FINISH_REASON = 50

const stripStepMarkers = (messages: WithParts[]): void => {
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let changed = false
        const filtered: typeof parts = []

        for (const part of parts) {
            if (part.type === "step-start") {
                changed = true
                continue
            }

            if (part.type === "step-finish") {
                const reason = (part as { reason?: unknown }).reason
                if (typeof reason === "string" && reason.length > MAX_STEP_FINISH_REASON) {
                    const truncated = reason.slice(0, MAX_STEP_FINISH_REASON) + "..."
                    // Skip when already truncated: keeps `changed` false on idempotent
                    // re-runs so the parts array reference (and prefix cache) stays stable.
                    if (truncated !== reason) {
                        filtered.push({ ...part, reason: truncated })
                        changed = true
                        continue
                    }
                }
            }

            filtered.push(part)
        }

        if (changed) {
            msg.parts = filtered
        }
    }
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
    messages: WithParts[],
): void => {
    if (state.prune.messages.byMessageId.size === 0) {
        return
    }

    const result: WithParts[] = []

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        const msgId = msg.info.id

        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        result.push(msg)
    }

    messages.length = 0
    messages.push(...result)
}
