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
    computeShouldNudge,
    countMessagesAfterIndex,
    estimateContextComposition,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
    resolveAdaptiveNudgeGrowth,
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

    const { providerId, modelId } = getModelInfo(messages)

    const { overMaxLimit, overMinLimit, currentTokens, modelContextLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        saveSessionState(state, logger).catch(() => {})
        return
    }

    let anchorsChanged = false

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

    const nudgeGrowthTokens =
        config.compress?.nudgeGrowthTokens ?? resolveAdaptiveNudgeGrowth(modelContextLimit)

    if (
        currentTokens !== undefined &&
        state.nudges.lastPerMessageNudgeTokens !== undefined &&
        currentTokens < state.nudges.lastPerMessageNudgeTokens - nudgeGrowthTokens
    ) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
    }

    const decision = computeShouldNudge({
        currentTokens,
        modelContextLimit,
        overMinLimit,
        overMaxLimit,
        lastNudgeTokens: state.nudges.lastPerMessageNudgeTokens,
        minNudgeContextPercent: config.compress?.minNudgeContextPercent ?? 15,
        nudgeGrowthTokens,
    })

    state.nudges.shouldInjectThisTurn = decision.shouldNudge

    if (
        state.nudges.lastPerMessageNudgeTokens === undefined &&
        currentTokens !== undefined
    ) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
    }

    const composition = estimateContextComposition(messages, state)
    const toolOutputThreshold = config.compress?.toolOutputNudgeThreshold ?? 5000
    let toolOutputReminder: string | null = null

    if (composition.toolTokens > 0) {
        if (state.nudges.lastToolOutputNudgeTokens === undefined) {
            state.nudges.lastToolOutputNudgeTokens = composition.toolTokens
        } else {
            const toolGrowth = composition.toolTokens - state.nudges.lastToolOutputNudgeTokens
            if (toolGrowth >= toolOutputThreshold) {
                const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
                const topRanges = composition.largestRanges.slice(0, 5).map((r) => `${r.ref} (${fmt(r.tokens)})`).join(", ")
                toolOutputReminder = `\n\n⚠️ ${fmt(toolGrowth)} new tool outputs accumulated (${fmt(composition.toolTokens)} total). Largest: ${topRanges}. Use compress tool to compress these ranges now.`
                state.nudges.lastToolOutputNudgeTokens = composition.toolTokens
                anchorsChanged = true
            }
        }
    }

    let tipsText: string | null = null

    if (decision.shouldNudge) {
        injectContextUsage(suffixMessage, config, currentTokens, modelContextLimit)

        if (suffixMessage && composition.total > 0) {
            const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
            const pct = (n: number) => Math.round((n / composition.total) * 100)
            const growth = currentTokens !== undefined && state.nudges.lastPerMessageNudgeTokens !== undefined
                ? currentTokens - state.nudges.lastPerMessageNudgeTokens : 0
            const growthStr = growth > 0 ? ` (+${fmt(growth)} since last nudge)` : ""

            const plainTextTokens = composition.textTokens
            // Soft nudges (growth/min-limit) are efficiency prompts, not overflow
            // warnings — a separate, stronger alert fires at maxLimit (below).
            const efficiencyNote = decision.tipsVariant !== "maxLimit"
                ? `\nThis is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.`
                : ""
            let breakdown = `${efficiencyNote}\nBreakdown: ${fmt(composition.toolTokens)} tool (${pct(composition.toolTokens)}%) | ${fmt(composition.summaryTokens)} summaries (${pct(composition.summaryTokens)}%) | ${fmt(composition.codeTokens)} code (${pct(composition.codeTokens)}%) | ${fmt(plainTextTokens)} text (${pct(plainTextTokens)}%)${growthStr}`

            const topBlocks = Array.from(state.prune.messages.blocksById.values())
                .filter((b) => b.active)
                .sort((a, b) => b.compressedTokens - a.compressedTokens)
                .slice(0, 3)
            if (topBlocks.length > 0) {
                breakdown += `\nTop blocks: ${topBlocks.map((b) => `b${b.blockId} ${fmt(b.compressedTokens)}→${fmt(b.summaryTokens)}`).join(", ")}`
            }
            if (composition.largestToolRanges.length > 0) {
                breakdown += `\nLargest tool outputs: ${composition.largestToolRanges.map((r) => `${r.ref} (${fmt(r.tokens)})`).join(", ")}`
            }
            if (composition.largestCodeRanges.length > 0) {
                breakdown += `\nLargest code messages: ${composition.largestCodeRanges.map((r) => `${r.ref} (${fmt(r.tokens)})`).join(", ")}`
            }
            if (composition.largestMessageRanges.length > 0) {
                breakdown += `\nLargest text messages: ${composition.largestMessageRanges.map((r) => `${r.ref} (${fmt(r.tokens)})`).join(", ")}`
            }
            breakdown += `\n💡 Compress incrementally: target the ranges above whose content you have already extracted for this step. Size alone is not a reason to compress — if a large range is still needed in full, keep it.`
            appendToLastTextPart(suffixMessage, breakdown)
        }

        if (decision.tipsVariant === "maxLimit") {
            tipsText = "\n\n⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n{ \"topic\": \"...\", \"content\": [{ \"startId\": \"<ID>\", \"endId\": \"<ID>\", \"summary\": \"...\" }] }\n\nOnly use IDs from visible messages above. Compress older work first."
        }
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        state.nudges.lastPerMessageNudgeTurn = state.currentTurn ?? 0

        if (config.compress.mode !== "message") {
            const visibleMessageIds = new Set<string>(
                messages.map((message) => message.info.id),
            )
            const blockGuidance = buildCompressedBlockGuidance(state, config.gc, {
                currentTokens,
                modelContextLimit,
                includeHint: tipsText !== null,
                visibleMessageIds,
            })
            if (blockGuidance.trim() && suffixMessage) {
                appendToLastTextPart(suffixMessage, "\n\n" + blockGuidance)
            }
        }

        if (tipsText && suffixMessage) {
            appendToLastTextPart(suffixMessage, tipsText)
        }

        injectVisibleIdRange(state, messages, suffixMessage)
    }

    if (toolOutputReminder && suffixMessage) {
        if (!decision.shouldNudge) {
            injectContextUsage(suffixMessage, config, currentTokens, modelContextLimit)
            if (composition.total > 0) {
                const fmt2 = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
                const pct2 = (n: number) => Math.round((n / composition.total) * 100)
                const topBlocks = Array.from(state.prune.messages.blocksById.values())
                    .filter((b) => b.active)
                    .sort((a, b) => b.compressedTokens - a.compressedTokens)
                    .slice(0, 3)
                let mini = `\nBreakdown: ${fmt2(composition.toolTokens)} tool outputs (${pct2(composition.toolTokens)}%) | ${fmt2(composition.summaryTokens)} summaries (${pct2(composition.summaryTokens)}%) | ${fmt2(composition.messageTokens)} messages (${pct2(composition.messageTokens)}%)`
                if (topBlocks.length > 0) {
                    mini += `\nTop blocks: ${topBlocks.map((b) => `b${b.blockId} ${fmt2(b.compressedTokens)}→${fmt2(b.summaryTokens)}`).join(", ")}`
                }
                appendToLastTextPart(suffixMessage, mini)
            }
        }
        appendToLastTextPart(suffixMessage, toolOutputReminder)
    }

    if (suffixMessage) {
        appendToLastTextPart(suffixMessage, "\n")
    }

    if (anchorsChanged) {
        saveSessionState(state, logger).catch(() => {})
    }
}

function injectContextUsage(
    target: WithParts | null,
    config: PluginConfig,
    currentTokens?: number,
    modelContextLimit?: number,
): void {
    if (!target) return
    const rawUsage = buildContextUsageGuidance(config, currentTokens, modelContextLimit)
    if (!rawUsage) return
    const usageTag = rawUsage

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
    const rangeTag = `\n\n[Visible messages: ${first} to ${last} (${visibleRefs.length} messages)]`

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
