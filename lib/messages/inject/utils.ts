import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import {
    appendGuidanceToDcpTag,
    buildCompressedBlockGuidance,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { RuntimePrompts } from "../../prompts/store"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
    type CompressionPriorityMap,
    type MessagePriority,
    listPriorityRefsBeforeIndex,
} from "../priority"
import {
    appendToTextPart,
    appendToLastTextPart,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import { getLastUserMessage, isIgnoredUserMessage, isSyntheticMessage } from "../query"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

interface ModelLimit {
    context: number
    input?: number
    output?: number
}

export function computeInputBudget(limit: ModelLimit): number | undefined {
    if (!limit.context) {
        return undefined
    }

    return limit.input ?? Math.max(0, limit.context - (limit.output ?? 0))
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        if (isSyntheticMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
}

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model?.providerID,
        modelId: userInfo.model?.modelID,
    }
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const parseLimitValue = (limit: number | `${number}%` | undefined): number | undefined => {
        if (limit === undefined) {
            return undefined
        }

        if (typeof limit === "number") {
            return limit
        }

        if (!limit.endsWith("%") || state.modelContextLimit === undefined) {
            return undefined
        }

        const parsedPercent = parseFloat(limit.slice(0, -1))
        if (isNaN(parsedPercent)) {
            return undefined
        }

        const roundedPercent = Math.round(parsedPercent)
        const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
        return Math.round((clampedPercent / 100) * state.modelContextLimit)
    }

    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return parseLimitValue(modelLimit)
        }
    }

    const globalLimit =
        threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
    return parseLimitValue(globalLimit)
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
) {
    const summaryTokenExtension = config.compress.summaryBuffer
        ? getActiveSummaryTokenUsage(state)
        : 0
    const resolvedMaxContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "max",
    )
    const maxContextLimit =
        resolvedMaxContextLimit === undefined
            ? undefined
            : resolvedMaxContextLimit + summaryTokenExtension
    const minContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const currentTokens = getCurrentTokenUsage(state, messages)

    let overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? false : currentTokens >= minContextLimit

    // [FIX Bug 20] Suppress overMax while cacheRead hasn't updated after compress
    if (overMaxLimit) {
        const recentCompressCount = 3
        const recentMessages = messages.slice(-recentCompressCount)
        for (const msg of recentMessages) {
            if (msg.info.role === "assistant" && msg.parts) {
                for (const part of msg.parts) {
                    if ((part as any).type === "tool-invocation" && (part as any).toolInvocation?.toolName === "compress") {
                        overMaxLimit = false
                        break
                    }
                }
            }
            if (!overMaxLimit) break
        }
    }

    return {
        overMaxLimit,
        overMinLimit,
        currentTokens,
        modelContextLimit: state.modelContextLimit,
    }
}

export type TipsVariant = "maxLimit" | "minLimit" | "normal"

export interface NudgeDecision {
    shouldNudge: boolean
    tipsVariant: TipsVariant | null
}

/**
 * Per-message Tips decision (pure — extracted for unit testing).
 *
 * Cadence is growth-only: first observed turn establishes a baseline (caller
 * records `currentTokens` into `lastPerMessageNudgeTokens` and we return
 * false); subsequent turns nudge when growth >= nudgeGrowthTokens or when
 * overMaxLimit forces it. The legacy 15% floor (minNudgeContextPercent) is
 * intentionally ignored — see devlog 2026-07-05_visible-range-guidance.
 */
export function computeShouldNudge(params: {
    currentTokens: number | undefined
    modelContextLimit: number | undefined
    overMinLimit: boolean
    overMaxLimit: boolean
    lastNudgeTokens: number | undefined
    /** @deprecated Kept for backward compat; ignored. Cadence is growth-only now. */
    minNudgeContextPercent: number
    nudgeGrowthTokens: number
}): NudgeDecision {
    const { currentTokens, overMinLimit, overMaxLimit } = params

    if (currentTokens === undefined) {
        return { shouldNudge: false, tipsVariant: null }
    }

    // First observed turn: caller records currentTokens as the growth baseline.
    if (params.lastNudgeTokens === undefined) {
        return { shouldNudge: false, tipsVariant: null }
    }

    const growthSinceLastNudge = currentTokens - params.lastNudgeTokens
    const shouldNudge = growthSinceLastNudge >= params.nudgeGrowthTokens || overMaxLimit

    if (!shouldNudge) {
        return { shouldNudge: false, tipsVariant: null }
    }

    const tipsVariant: TipsVariant = overMaxLimit
        ? "maxLimit"
        : overMinLimit
          ? "minLimit"
          : "normal"
    return { shouldNudge: true, tipsVariant }
}

const NUDGE_GROWTH_FLOOR = 6000
const NUDGE_GROWTH_CAP = 50000
const NUDGE_GROWTH_RATIO = 0.05

export function resolveAdaptiveNudgeGrowth(modelContextLimit: number | undefined): number {
    if (!modelContextLimit || modelContextLimit <= 0) return NUDGE_GROWTH_FLOOR
    return Math.min(
        NUDGE_GROWTH_CAP,
        Math.max(NUDGE_GROWTH_FLOOR, Math.round(modelContextLimit * NUDGE_GROWTH_RATIO)),
    )
}

export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

function buildMessagePriorityGuidance(
    messages: WithParts[],
    compressionPriorities: CompressionPriorityMap | undefined,
    anchorIndex: number,
    priority: MessagePriority,
): string {
    if (!compressionPriorities || compressionPriorities.size === 0) {
        return ""
    }

    const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority)
    const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`

    return renderMessagePriorityGuidance(priorityLabel, refs)
}

function injectAnchoredNudge(message: WithParts, nudgeText: string): void {
    if (!nudgeText.trim()) {
        return
    }

    if (message.info.role === "user") {
        if (appendToLastTextPart(message, nudgeText)) {
            return
        }

        message.parts.push(createSyntheticTextPart(message, nudgeText))
        return
    }

    if (message.info.role !== "assistant") {
        return
    }

    if (!hasContent(message)) {
        return
    }

    for (const part of message.parts) {
        if (part.type === "text") {
            if (appendToTextPart(part, nudgeText)) {
                return
            }
        }
    }

    const syntheticPart = createSyntheticTextPart(message, nudgeText)
    const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
    if (firstToolIndex === -1) {
        message.parts.push(syntheticPart)
    } else {
        message.parts.splice(firstToolIndex, 0, syntheticPart)
    }
}

function collectAnchoredMessages(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
): Array<{ message: WithParts; index: number }> {
    const anchoredMessages: Array<{ message: WithParts; index: number }> = []

    for (const anchorMessageId of anchorMessageIds) {
        const index = messages.findIndex((message) => message.info.id === anchorMessageId)
        if (index === -1) {
            continue
        }

        anchoredMessages.push({
            message: messages[index],
            index,
        })
    }

    return anchoredMessages
}

function collectTurnNudgeAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): Set<string> {
    const turnNudgeAnchors = new Set<string>()
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

    for (const message of messages) {
        if (!state.nudges.turnNudgeAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    return turnNudgeAnchors
}

function applyRangeModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressedBlockGuidance: string,
): void {
    const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance)
    if (!nudgeText.trim()) {
        return
    }

    for (const { message } of collectAnchoredMessages(anchorMessageIds, messages)) {
        injectAnchoredNudge(message, nudgeText)
    }
}

function applyMessageModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressionPriorities?: CompressionPriorityMap,
): void {
    for (const { message, index } of collectAnchoredMessages(anchorMessageIds, messages)) {
        const priorityGuidance = buildMessagePriorityGuidance(
            messages,
            compressionPriorities,
            index,
            MESSAGE_MODE_NUDGE_PRIORITY,
        )
        const nudgeText = appendGuidanceToDcpTag(baseNudgeText, priorityGuidance)
        injectAnchoredNudge(message, nudgeText)
    }
}

/**
 * Resolve a config threshold (number | "NN%") to a percentage value.
 */
function resolveThresholdPercent(
    threshold: number | `${number}%` | undefined,
    modelContextLimit: number | undefined,
): number | undefined {
    if (threshold === undefined) return undefined
    if (typeof threshold === "number") {
        if (!modelContextLimit) return undefined
        return (threshold / modelContextLimit) * 100
    }
    const parsed = parseFloat(threshold)
    return isNaN(parsed) ? undefined : parsed
}

/**
 * Build tiered context usage guidance based on actual config thresholds.
 * Shared by inject.ts (suffix message) and utils.ts (anchored nudges).
 */
export function buildContextUsageGuidance(
    config: PluginConfig,
    currentTokens?: number,
    modelContextLimit?: number,
): string {
    if (currentTokens === undefined || modelContextLimit === undefined || modelContextLimit === 0) {
        return ""
    }

    const formatK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

    return `\n\nContext: ${formatK(currentTokens)} tokens.\nAll compression serves the primary task, but be frugal. Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools. Compress by need, not by percentage.`
}

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
    currentTokens?: number,
    modelContextLimit?: number,
    suffixMessage?: WithParts | null,
): void {
    const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages)

    if (suffixMessage) {
        const nudgeParts: string[] = []

        if (config.compress.mode === "message") {
            if (state.nudges.contextLimitAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(state.nudges.contextLimitAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(prompts.contextLimitNudge, guidance))
                }
            }
            if (turnNudgeAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(turnNudgeAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(prompts.turnNudge, guidance))
                }
            }
            if (state.nudges.iterationNudgeAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(state.nudges.iterationNudgeAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(prompts.iterationNudge, guidance))
                }
            }
        } else {
            if (state.nudges.contextLimitAnchors.size > 0) {
                nudgeParts.push(prompts.contextLimitNudge)
            }
            if (turnNudgeAnchors.size > 0) {
                nudgeParts.push(prompts.turnNudge)
            }
            if (state.nudges.iterationNudgeAnchors.size > 0) {
                nudgeParts.push(prompts.iterationNudge)
            }
        }

        const combined = nudgeParts.join("\n\n")
        if (combined.trim()) {
            injectAnchoredNudge(suffixMessage, combined)
        }
        return
    }

    if (config.compress.mode === "message") {
        applyMessageModeAnchoredNudge(
            state.nudges.contextLimitAnchors,
            messages,
            prompts.contextLimitNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            turnNudgeAnchors,
            messages,
            prompts.turnNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.iterationNudgeAnchors,
            messages,
            prompts.iterationNudge,
            compressionPriorities,
        )
        return
    }

    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        prompts.contextLimitNudge,
        "",
    )
    applyRangeModeAnchoredNudge(
        turnNudgeAnchors,
        messages,
        prompts.turnNudge,
        "",
    )
    applyRangeModeAnchoredNudge(
        state.nudges.iterationNudgeAnchors,
        messages,
        prompts.iterationNudge,
        "",
    )
}

export interface ContextComposition {
    toolTokens: number
    summaryTokens: number
    messageTokens: number
    total: number
    largestRanges: { ref: string; tokens: number }[]
}

export function estimateContextComposition(
    messages: WithParts[],
    state?: SessionState,
): ContextComposition {
    let toolTokens = 0
    let summaryTokens = 0
    let messageTokens = 0
    const perMessage: { ref: string; tokens: number }[] = []

    for (const msg of messages) {
        const text = (msg.parts || [])
            .filter((p) => p.type === "text")
            .map((p: any) => p.text || "")
            .join("")
        const msgId = (msg.info as any)?.id || ""
        const isSummary = msgId.startsWith("msg_dcp_summary") || text.includes("[Compressed conversation section]")

        let msgTotal = 0
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                const tokens = Math.round((part as any).text.length / 4)
                msgTotal += tokens
                if (isSummary) {
                    summaryTokens += tokens
                } else {
                    messageTokens += tokens
                }
            } else if (part.type !== "text" && part.type !== "reasoning") {
                const raw = JSON.stringify(part)
                const tokens = Math.round(raw.length / 4)
                msgTotal += tokens
                toolTokens += tokens
            }
        }

        if (!isSummary && msgTotal > 500) {
            const ref = state?.messageIds?.byRawId?.get(msgId) || "?"
            perMessage.push({ ref, tokens: msgTotal })
        }
    }

    perMessage.sort((a, b) => b.tokens - a.tokens)

    return {
        toolTokens,
        summaryTokens,
        messageTokens,
        total: toolTokens + summaryTokens + messageTokens,
        largestRanges: perMessage.slice(0, 5),
    }
}
