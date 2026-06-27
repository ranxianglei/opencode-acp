import type { PluginConfig } from "../../config/types"
import type { SessionState, WithParts, CompressionBlock } from "../../state/types"
import type { Logger } from "../../infra/logger"
import type { Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { countTokensSync } from "../../infra/token-counter"
import { getActiveBlocks } from "../../state/queries"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"
import { getLastUserMessage, isIgnoredUserMessage } from "../query"
import {
    appendToLastTextPart,
    appendToTextPart,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    appendGuidanceToDcpTag,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { CompressionPriorityMap, MessagePriority } from "../priority"
import { listPriorityRefsBeforeIndex } from "../priority"

export { computeInputBudget as computeInputBudgetFromConfig } from "../utils"

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

export function computeContextUsage(
    state: SessionState,
    messages: WithParts[],
): number {
    const limit = state.modelContextLimit
    if (!limit || limit <= 0) return 0
    const used = estimateMessagesTokens(messages)
    if (used <= 0) return 0
    return Math.min(100, Math.round((used / limit) * 100))
}

export function getMessagesSinceLastUser(messages: WithParts[]): number {
    if (!Array.isArray(messages)) return 0
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg && msg.info && msg.info.role === "user") {
            return messages.length - 1 - i
        }
    }
    return messages.length
}

export function shouldShowBlockAgingWarning(
    state: SessionState,
    config: PluginConfig,
    contextUsagePercent: number,
): boolean {
    if (contextUsagePercent <= 50) return false
    const maxBlockAge = config.gc.maxBlockAge
    if (typeof maxBlockAge !== "number" || maxBlockAge <= 0) return false
    const agingThreshold = Math.floor(maxBlockAge / 2)
    const active = getActiveBlocks(state)
    for (const block of active) {
        if (isApproachingMaxAge(block, agingThreshold)) return true
    }
    return false
}

function isApproachingMaxAge(block: CompressionBlock, agingThreshold: number): boolean {
    if (block.generation !== "old") return false
    const survived = typeof block.survivedCount === "number" ? block.survivedCount : 0
    return survived >= agingThreshold
}

function estimateMessagesTokens(messages: WithParts[]): number {
    if (!Array.isArray(messages)) return 0
    let total = 0
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.parts)) continue
        for (const part of msg.parts) {
            if (!part) continue
            const p = part as {
                type?: string
                text?: unknown
                state?: { output?: unknown }
            }
            if (typeof p.text === "string") {
                total += countTokensSync(p.text)
            }
            if (p.type === "tool" && p.state && typeof p.state.output === "string") {
                total += countTokensSync(p.state.output)
            }
        }
    }
    return total
}

interface ModelLimit {
    context: number
    input?: number
    output?: number
}

export interface RuntimePrompts {
    system: string
    compressRange: string
    compressMessage: string
    contextLimitNudge: string
    turnNudge: string
    iterationNudge: string
    manualExtension?: string
    subagentExtension?: string
    decompressExtension?: string
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const parseLimitValue = (limit: number | string | undefined): number | undefined => {
        if (limit === undefined) {
            return undefined
        }

        if (typeof limit === "number") {
            return limit
        }

        if (typeof limit !== "string" || !limit.endsWith("%") || state.modelContextLimit === undefined) {
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

export interface ContextOverLimitsResult {
    overMaxLimit: boolean
    overMinLimit: boolean
    currentTokens: number
    modelContextLimit: number | undefined
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
): ContextOverLimitsResult {
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

    if (overMaxLimit) {
        const recentCompressCount = 3
        const recentMessages = messages.slice(-recentCompressCount)
        for (const msg of recentMessages) {
            if (msg.info.role === "assistant" && msg.parts) {
                for (const part of msg.parts) {
                    const p = part as { type?: string; toolInvocation?: { toolName?: string } }
                    if (p.type === "tool-invocation" && p.toolInvocation?.toolName === "compress") {
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

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

interface LastNonIgnoredEntry {
    message: WithParts
    index: number
}

function findLastNonIgnoredEntry(messages: WithParts[]): LastNonIgnoredEntry | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message || !message.info) continue
        if (isIgnoredUserMessage(message)) continue
        const id = message.info.id
        if (typeof id === "string" && (id.startsWith("msg_dcp_summary_") || id.startsWith("msg_dcp_text_"))) {
            continue
        }
        return { message, index: i }
    }
    return null
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
            message: messages[index]!,
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
    const sourceAnchors = (state.nudges as { turnNudgeAnchors?: Set<string> }).turnNudgeAnchors
    if (!sourceAnchors) return turnNudgeAnchors

    for (const message of messages) {
        if (!sourceAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    return turnNudgeAnchors
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
            if (appendToTextPart(part as Part, nudgeText)) {
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

function applyRangeModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
): void {
    if (!baseNudgeText.trim()) {
        return
    }

    for (const { message } of collectAnchoredMessages(anchorMessageIds, messages)) {
        injectAnchoredNudge(message, baseNudgeText)
    }
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
    const contextUsageInfo = buildContextUsageGuidance(config, currentTokens, modelContextLimit)
    const contextLimitNudgeWithUsage = prompts.contextLimitNudge + contextUsageInfo
    const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages)

    if (suffixMessage) {
        const nudgeParts: string[] = []

        if (config.compress.mode === "message") {
            if (state.nudges.contextLimitAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(state.nudges.contextLimitAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(contextLimitNudgeWithUsage, guidance))
                }
            }
            if (turnNudgeAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(turnNudgeAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(prompts.turnNudge, guidance))
                }
            }
            if (state.nudges.iterationAnchors.size > 0) {
                for (const { index } of collectAnchoredMessages(state.nudges.iterationAnchors, messages)) {
                    const guidance = buildMessagePriorityGuidance(messages, compressionPriorities, index, MESSAGE_MODE_NUDGE_PRIORITY)
                    nudgeParts.push(appendGuidanceToDcpTag(prompts.iterationNudge, guidance))
                }
            }
        } else {
            if (state.nudges.contextLimitAnchors.size > 0) {
                nudgeParts.push(contextLimitNudgeWithUsage)
            }
            if (turnNudgeAnchors.size > 0) {
                nudgeParts.push(prompts.turnNudge)
            }
            if (state.nudges.iterationAnchors.size > 0) {
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
            contextLimitNudgeWithUsage,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            turnNudgeAnchors,
            messages,
            prompts.turnNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.iterationAnchors,
            messages,
            prompts.iterationNudge,
            compressionPriorities,
        )
        return
    }

    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        contextLimitNudgeWithUsage,
    )
    applyRangeModeAnchoredNudge(
        turnNudgeAnchors,
        messages,
        prompts.turnNudge,
    )
    applyRangeModeAnchoredNudge(
        state.nudges.iterationAnchors,
        messages,
        prompts.iterationNudge,
    )
}

function resolveThresholdPercent(
    threshold: number | string | undefined,
    modelContextLimit: number | undefined,
): number | undefined {
    if (threshold === undefined) return undefined
    if (typeof threshold === "number") {
        if (!modelContextLimit) return undefined
        return (threshold / modelContextLimit) * 100
    }
    if (typeof threshold !== "string") return undefined
    if (!threshold.endsWith("%")) {
        const parsed = parseFloat(threshold)
        return isNaN(parsed) ? undefined : parsed
    }
    const parsed = parseFloat(threshold.slice(0, -1))
    return isNaN(parsed) ? undefined : parsed
}

export function buildContextUsageGuidance(
    config: PluginConfig,
    currentTokens?: number,
    modelContextLimit?: number,
): string {
    if (currentTokens === undefined || modelContextLimit === undefined || modelContextLimit === 0) {
        return ""
    }

    const pct = (currentTokens / modelContextLimit) * 100
    const percentage = pct.toFixed(1)
    const formatK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

    const minPct = resolveThresholdPercent(config.compress.minContextLimit, modelContextLimit) ?? 45
    const maxPct = resolveThresholdPercent(config.compress.maxContextLimit, modelContextLimit) ?? 55

    const base = `Context usage: ${formatK(currentTokens)} / ${formatK(modelContextLimit)} tokens (${percentage}%). ACP threshold: ${maxPct.toFixed(0)}%.`

    let guidance: string
    if (pct < minPct) {
        guidance = " Context is ample — focus on your task. Only compress obvious waste (large terminal outputs, duplicated content)."
    } else if (pct < maxPct) {
        guidance = " Context is moderate — compress completed sections and high-token waste. Preserve key details."
    } else {
        guidance = " Context is high — compress aggressively but selectively. Preserve only what is essential."
    }

    return `\n\n${base}${guidance}`
}

export type { TextPart, UserMessage }
