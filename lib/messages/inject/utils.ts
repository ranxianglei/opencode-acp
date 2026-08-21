import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import { messageContainsProtectedTool } from "../../compress/protected-content"
import { isToolNameProtected, getFilePathsFromParameters, isFilePathProtected } from "../../protected-patterns"
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
import { estimateSystemPromptTokens } from "../../token-utils"
import {
    appendToTextPart,
    appendToLastTextPart,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import { getLastUserMessage, isIgnoredUserMessage, isSyntheticMessage } from "../query"
import { getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

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
        ? getActiveSummaryTokenUsage(
              state,
              new Set(messages.map((m) => m.info.id)),
          )
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
                    if (part.type === "tool" && part.tool === "compress") {
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

import {
    ensureBuiltinTriggerPolicyRegistered,
    getDefaultTriggerPolicy,
} from "./policy"
ensureBuiltinTriggerPolicyRegistered()

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
    const policy = getDefaultTriggerPolicy()
    if (!policy) {
        return { shouldNudge: false, tipsVariant: null }
    }
    return policy.computeShouldNudge(params)
}

export const DEFAULT_NUDGE_GROWTH_TOKENS = 50_000

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

        if (state.nudges.contextLimitAnchors.size > 0) {
            nudgeParts.push(prompts.contextLimitNudge)
        }
        if (turnNudgeAnchors.size > 0) {
            nudgeParts.push(prompts.turnNudge)
        }
        if (state.nudges.iterationNudgeAnchors.size > 0) {
            nudgeParts.push(prompts.iterationNudge)
        }

        const combined = nudgeParts.join("\n\n")
        if (combined.trim()) {
            injectAnchoredNudge(suffixMessage, combined)
        }
        return
    }

    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        prompts.contextLimitNudge,
        "",
    )
    applyRangeModeAnchoredNudge(turnNudgeAnchors, messages, prompts.turnNudge, "")
    applyRangeModeAnchoredNudge(
        state.nudges.iterationNudgeAnchors,
        messages,
        prompts.iterationNudge,
        "",
    )
}

export interface ContextComposition {
    toolTokens: number
    codeTokens: number
    summaryTokens: number
    messageTokens: number
    textTokens: number
    systemTokens: number
    protectedTokens: number
    total: number
    largestRanges: { ref: string; tokens: number }[]
    largestToolRanges: { ref: string; tokens: number; tool?: string }[]
    largestCodeRanges: { ref: string; tokens: number }[]
    largestMessageRanges: { ref: string; tokens: number }[]
    toolTypeBreakdown: { tool: string; tokens: number }[]
}

function estimateCodeTokens(text: string): number {
    let codeChars = 0
    let inCode = false
    for (const line of text.split("\n")) {
        if (line.trim().startsWith("```")) {
            inCode = !inCode
            codeChars += line.length + 1
            continue
        }
        if (inCode) codeChars += line.length + 1
    }
    return Math.round(codeChars / 4)
}

export function estimateContextComposition(
    messages: WithParts[],
    state?: SessionState,
    protectedTools: string[] = [],
    protectedFilePatterns: string[] = [],
): ContextComposition {
    let toolTokens = 0
    let codeTokens = 0
    let summaryTokens = 0
    let messageTokens = 0
    let protectedTokens = 0
    const perMessage: { ref: string; tokens: number }[] = []
    const perTool: { ref: string; tokens: number; tool?: string }[] = []
    const perCode: { ref: string; tokens: number }[] = []
    const perText: { ref: string; tokens: number }[] = []
    const toolTypeMap = new Map<string, number>()

    for (const msg of messages) {
        const text = (msg.parts || [])
            .filter((p) => p.type === "text")
            .map((p: any) => p.text || "")
            .join("")
        const msgId = (msg.info as any)?.id || ""
        const isSummary =
            msgId.startsWith("msg_dcp_summary") ||
            text.includes("[Compressed conversation section]")

        const isProtected =
            (protectedTools.length > 0 || protectedFilePatterns.length > 0) &&
            messageContainsProtectedTool(msg, protectedTools, protectedFilePatterns)

        let msgTotal = 0
        let msgTool = 0
        let msgCode = 0
        let msgText = 0
        let msgToolName = ""

        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                const partText = (part as any).text as string
                const tokens = Math.round(partText.length / 4)
                msgTotal += tokens
                if (isSummary) {
                    summaryTokens += tokens
                } else {
                    messageTokens += tokens
                    msgText += tokens
                    const cTokens = estimateCodeTokens(partText)
                    if (cTokens > 0) {
                        codeTokens += cTokens
                        msgCode += cTokens
                    }
                }
            } else if (part.type === "tool") {
                const raw = JSON.stringify(part)
                const tokens = Math.round(raw.length / 4)
                msgTotal += tokens
                const toolName = (part as any)?.tool || "unknown"

                // Compress-as-anchor (v1.12.9+): classify summary content as
                // summaryTokens, not toolTokens. The summary text lives in
                // part.state.input.content[].summary.
                let summaryPartTokens = 0
                if (toolName === "compress") {
                    const input = (part as any)?.state?.input
                    if (input?.content && Array.isArray(input.content)) {
                        for (const entry of input.content) {
                            if (typeof entry?.summary === "string") {
                                summaryPartTokens += Math.round(entry.summary.length / 4)
                            }
                        }
                    }
                }
                const toolPartTokens = Math.max(0, tokens - summaryPartTokens)
                toolTokens += toolPartTokens
                msgTool += toolPartTokens
                summaryTokens += summaryPartTokens
                toolTypeMap.set(toolName, (toolTypeMap.get(toolName) || 0) + toolPartTokens)
                if (!msgToolName) msgToolName = toolName
            }
        }

        if (isProtected && !isSummary) {
            protectedTokens += msgTotal
        }

        if (!isSummary) {
            const ref = state?.messageIds?.byRawId?.get(msgId) || "?"
            if (msgTotal > 500) perMessage.push({ ref, tokens: msgTotal })
            if (msgTool > 500) perTool.push({ ref, tokens: msgTool, tool: msgToolName })
            if (msgCode > 300) perCode.push({ ref, tokens: msgCode })
            if (msgText > 500 && msgCode === 0) perText.push({ ref, tokens: msgText })
        }
    }

    perMessage.sort((a, b) => b.tokens - a.tokens)
    perTool.sort((a, b) => b.tokens - a.tokens)
    perCode.sort((a, b) => b.tokens - a.tokens)
    perText.sort((a, b) => b.tokens - a.tokens)

    const toolTypeBreakdown = Array.from(toolTypeMap.entries())
        .map(([tool, tokens]) => ({ tool, tokens }))
        .sort((a, b) => b.tokens - a.tokens)

    const systemTokens =
        state?.systemPromptTokens !== undefined && state.systemPromptTokens > 0
            ? state.systemPromptTokens
            : estimateSystemPromptTokens(messages)

    return {
        toolTokens,
        codeTokens,
        summaryTokens,
        messageTokens,
        textTokens: Math.max(0, messageTokens - codeTokens),
        systemTokens,
        protectedTokens,
        total: systemTokens + toolTokens + summaryTokens + messageTokens,
        largestRanges: perMessage.slice(0, 15),
        largestToolRanges: perTool.slice(0, 15),
        largestCodeRanges: perCode.slice(0, 5),
        largestMessageRanges: perText.slice(0, 5),
        toolTypeBreakdown,
    }
}

export interface CompressibleRange {
    startRef: string
    endRef: string
    count: number
    tokens: number
    /**
     * Tokens that would actually survive the compress pipeline's soft
     * filters (last-user-message, no-meaningful-content). The pipeline
     * silently drops those messages from plans, so `tokens` overstates
     * what a compression would free. Recommendations and displays use
     * this field to stay honest (phantom-loop fix, issue #37 session
     * ses_7fb5cbc8: ranges shown as "10.8K compressible" resolved to
     * 3066 chars in the pipeline → min-size rejection → retry loop).
     */
    effectiveTokens: number
    toolPct: number
    textPct: number
    dangerous?: boolean
}

export interface ProtectedRange {
    startRef: string
    endRef: string
    count: number
    tokens: number
    tools: string[]
}

export interface ContextRanges {
    compressible: CompressibleRange[]
    protected: ProtectedRange[]
}

function refNum(ref: string): number {
    const n = parseInt(ref.slice(1), 10)
    return Number.isNaN(n) ? -1 : n
}

export function buildCompressibleRanges(
    messages: WithParts[],
    state: SessionState,
    protectedTools: string[] = [],
    protectedFilePatterns: string[] = [],
    protectedZoneRefs?: Set<string>,
): ContextRanges {
    const msgInfo: {
        ref: string
        refNum: number
        tokens: number
        effectiveTokens: number
        meaningful: boolean
        isTool: boolean
        isUser: boolean
    }[] = []
    const protectedMsgInfo: {
        ref: string
        refNum: number
        tokens: number
        tools: string[]
    }[] = []
    const lastUserRefIdx: number[] = []
    for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi]
        if (isSyntheticMessage(msg)) continue
        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (!ref) continue

        const rn = parseInt(ref.slice(1), 10)

        if (
            (protectedTools.length > 0 || protectedFilePatterns.length > 0) &&
            messageContainsProtectedTool(msg, protectedTools, protectedFilePatterns)
        ) {
            let tokens = 0
            const tools = new Set<string>()
            for (const part of msg.parts || []) {
                if (part.type === "text" && typeof (part as any).text === "string") {
                    tokens += Math.round(((part as any).text as string).length / 4)
                } else if (part.type !== "text" && part.type !== "reasoning") {
                    tokens += Math.round(JSON.stringify(part).length / 4)
                    const toolName = (part as any)?.tool
                    const callID = (part as any)?.callID
                    if (toolName && callID) {
                        if (isToolNameProtected(toolName, protectedTools)) {
                            tools.add(toolName)
                        } else if (protectedFilePatterns.length > 0) {
                            const filePaths = getFilePathsFromParameters(
                                toolName,
                                (part as any)?.state?.input,
                            )
                            if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                                tools.add(toolName)
                            }
                        }
                    }
                }
            }
            protectedMsgInfo.push({ ref, refNum: rn, tokens, tools: [...tools] })
            continue
        }

        let tokens = 0
        let isTool = false
        let hasMeaningfulPart = false
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
                if ((part as any).text.trim().length > 0) hasMeaningfulPart = true
            } else if (part.type !== "text" && part.type !== "reasoning") {
                tokens += Math.round(JSON.stringify(part).length / 4)
                isTool = true
                hasMeaningfulPart = true
            }
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            lastUserRefIdx.length = 0
            lastUserRefIdx.push(msgInfo.length)
        }
        msgInfo.push({ ref, refNum: rn, tokens, effectiveTokens: 0, meaningful: hasMeaningfulPart, isTool, isUser: msg.info.role === "user" })
    }

    const lastUserIdx = lastUserRefIdx.length > 0 ? lastUserRefIdx[0] : -1
    for (let i = 0; i < msgInfo.length; i++) {
        const info = msgInfo[i]
        info.effectiveTokens = i !== lastUserIdx && info.meaningful ? info.tokens : 0
    }

    const groups: CompressibleRange[] = []
    let cur: CompressibleRange | null = null
    let prevRefNum = -2
    for (const info of msgInfo) {
        // Split groups at the protected-zone boundary: close the current group
        // before skipping protected messages, so the unprotected head survives
        // as its own range instead of being swallowed by excludeProtectedRanges.
        if (protectedZoneRefs?.has(info.ref)) {
            if (cur) {
                groups.push(cur)
                cur = null
            }
            prevRefNum = info.refNum
            continue
        }
        const hasGap = info.refNum > prevRefNum + 1
        if (cur && ((info.isUser && cur.count >= 3) || hasGap)) {
            groups.push(cur)
            cur = null
        }
        prevRefNum = info.refNum
        if (!cur) {
            cur = {
                startRef: info.ref,
                endRef: info.ref,
                count: 1,
                tokens: info.tokens,
                effectiveTokens: info.effectiveTokens,
                toolPct: info.isTool ? 100 : 0,
                textPct: info.isTool ? 0 : 100,
            }
        } else {
            cur.endRef = info.ref
            cur.count++
            cur.tokens += info.tokens
            cur.effectiveTokens += info.effectiveTokens
            if (info.isTool) {
                cur.toolPct = Math.round((cur.toolPct * (cur.count - 1) + 100) / cur.count)
            } else {
                cur.toolPct = Math.round((cur.toolPct * (cur.count - 1)) / cur.count)
            }
            cur.textPct = 100 - cur.toolPct
        }
    }
    if (cur) groups.push(cur)

    const protectedGroups: ProtectedRange[] = []
    let pcur: ProtectedRange | null = null
    let pPrevRefNum = -2
    for (const info of protectedMsgInfo) {
        const hasGap = info.refNum > pPrevRefNum + 1
        if (pcur && hasGap) {
            protectedGroups.push(pcur)
            pcur = null
        }
        pPrevRefNum = info.refNum
        if (!pcur) {
            pcur = {
                startRef: info.ref,
                endRef: info.ref,
                count: 1,
                tokens: info.tokens,
                tools: [...info.tools],
            }
        } else {
            pcur.endRef = info.ref
            pcur.count++
            pcur.tokens += info.tokens
            for (const t of info.tools) {
                if (!pcur.tools.includes(t)) pcur.tools.push(t)
            }
        }
    }
    if (pcur) protectedGroups.push(pcur)

    return {
        compressible: groups.filter((g) => g.tokens > 0),
        protected: protectedGroups,
    }
}

export interface RangeFilterOptions {
    logger?: { debug: (msg: string, data?: any) => void }
    minEffectiveTokens?: number
}

/**
 * DEFAULT token floor for a range to stay in the recommendation list, aligned
 * with the compress pipeline's default minCompressRange (5000 chars ÷ 4
 * chars/token). The actual floor is derived from the configured
 * `compress.minCompressRange` via `resolveEffectiveFloor` so the recommendation
 * tracks the pipeline's real rejection threshold. Ranges whose effective
 * compressible content falls below the floor would be rejected by the
 * pipeline's minimum-size check, so recommending them only invites
 * guaranteed-failed compress calls (the retry loop observed in issue #37
 * session ses_7fb5cbc8: displayed "10.8K compressible" resolved to 3066 chars
 * in the pipeline → rejected → model retried ×10).
 */
export const EFFECTIVE_MIN_COMPRESSIBLE_TOKENS = 1250

/**
 * Derive the effective-token recommendation floor from the pipeline's
 * char-based `compress.minCompressRange` (÷ 4 chars/token). When
 * minCompressRange is 0 the pipeline's size check is disabled, so the floor
 * is 0 — but the universal phantom guard (`effective > 0`) still applies in
 * filterRecommendedRanges: a range whose every message is soft-filtered
 * produces a phantom plan the pipeline always rejects.
 */
export function resolveEffectiveFloor(config: {
    compress?: { minCompressRange?: number }
}): number {
    const minChars = config.compress?.minCompressRange ?? 5000
    return minChars > 0 ? Math.floor(minChars / 4) : 0
}

/**
 * Filter compressible ranges for the recommendation list.
 *
 * Ranges whose effective compressible content (after the pipeline's soft
 * filters: last-user-message, no-meaningful-content) falls below
 * EFFECTIVE_MIN_COMPRESSIBLE_TOKENS are dropped — the pipeline's
 * minCompressRange check would reject them anyway. The last surviving
 * segment is marked `dangerous: true` (it may still be in active use).
 *
 * Issue #251: Previously this function used `growthThreshold` (5% of context
 * window = 50K at 1M) as an aggregate gate — if "effective compressible"
 * was below the threshold, ALL ranges were suppressed and the nudge was
 * hidden. At large context windows, individual ranges rarely exceeded this
 * threshold, so compression was permanently blocked. The aggregate gate
 * has been removed. The per-range effective floor below is 1250 tokens —
 * far below #251's 50K, and matched to the pipeline's own acceptance
 * criteria rather than the context size.
 */
export function filterRecommendedRanges(
    compressible: CompressibleRange[],
    _protectedRanges: ProtectedRange[],
    options: RangeFilterOptions,
): CompressibleRange[] {
    const { logger } = options
    const log = logger?.debug.bind(logger)

    if (compressible.length === 0) {
        log?.("filterRecommendedRanges: no compressible ranges, returning empty")
        return []
    }

    const floor = options.minEffectiveTokens ?? EFFECTIVE_MIN_COMPRESSIBLE_TOKENS
    const kept = compressible.filter((r) => {
        const effective = r.effectiveTokens ?? r.tokens
        return effective > 0 && effective >= floor
    })

    const result = kept.map((r, i) =>
        i === kept.length - 1 ? { ...r, dangerous: true } : r,
    )

    log?.("filterRecommendedRanges: effective-token floor applied", {
        inputRanges: compressible.length,
        outputRanges: result.length,
        floor,
        dropped: compressible
            .filter((r) => {
                const effective = r.effectiveTokens ?? r.tokens
                return effective <= 0 || effective < floor
            })
            .map((r) => `${r.startRef}–${r.endRef} (${r.effectiveTokens ?? r.tokens} eff tokens)`),
    })

    return result
}

interface MergedEntry {
    startRef: string
    endRef: string
    startNum: number
    endNum: number
    count: number
    tokens: number
    toolPct: number
    textPct: number
    compressibleTokens: number
    compressibleCount: number
    protectedTokens: number
    protectedCount: number
    protectedTools: string[]
    dangerous: boolean
}

export function formatCompressibleRanges(
    ranges: CompressibleRange[],
    protectedRanges?: ProtectedRange[],
): string {
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

    if (!protectedRanges || protectedRanges.length === 0) {
        if (ranges.length === 0) return ""
        const lines = ranges.map((r) => {
            const eff = r.effectiveTokens ?? r.tokens
            const size = eff < r.tokens
                ? `${fmt(eff)} effective of ${fmt(r.tokens)}`
                : fmt(r.tokens)
            const suffix = r.dangerous ? "  ⚠️ NOT recommended unless you are certain. If you MUST compress this, pass `dangerous: true`." : ""
            return `  ${r.startRef}–${r.endRef}  ${r.count} msgs  ${size} [tool ${r.toolPct}% | text ${r.textPct}%]${suffix}`
        })
        return `Compressible ranges (oldest first):\n${lines.join("\n")}`
    }

    const entries: MergedEntry[] = []

    for (const r of ranges) {
        entries.push({
            startRef: r.startRef,
            endRef: r.endRef,
            startNum: refNum(r.startRef),
            endNum: refNum(r.endRef),
            count: r.count,
            tokens: r.tokens,
            toolPct: r.toolPct,
            textPct: r.textPct,
            compressibleTokens: r.effectiveTokens ?? r.tokens,
            compressibleCount: r.count,
            protectedTokens: 0,
            protectedCount: 0,
            protectedTools: [],
            dangerous: r.dangerous ?? false,
        })
    }
    for (const r of protectedRanges) {
        entries.push({
            startRef: r.startRef,
            endRef: r.endRef,
            startNum: refNum(r.startRef),
            endNum: refNum(r.endRef),
            count: r.count,
            tokens: r.tokens,
            toolPct: 0,
            textPct: 0,
            compressibleTokens: 0,
            compressibleCount: 0,
            protectedTokens: r.tokens,
            protectedCount: r.count,
            protectedTools: [...r.tools],
            dangerous: false,
        })
    }

    entries.sort((a, b) => a.startNum - b.startNum)

    const merged: MergedEntry[] = []
    for (const entry of entries) {
        const last = merged[merged.length - 1]
        if (last && entry.startNum <= last.endNum + 1) {
            last.endRef = entry.endRef
            last.endNum = Math.max(last.endNum, entry.endNum)
            last.count += entry.count
            last.tokens += entry.tokens
            last.compressibleTokens += entry.compressibleTokens
            last.compressibleCount += entry.compressibleCount
            last.protectedTokens += entry.protectedTokens
            last.protectedCount += entry.protectedCount
            if (entry.dangerous) last.dangerous = true
            for (const t of entry.protectedTools) {
                if (!last.protectedTools.includes(t)) last.protectedTools.push(t)
            }
        } else {
            merged.push({ ...entry })
        }
    }

    const lines = merged.map((e) => {
        const suffix = e.dangerous && e.compressibleTokens > 0 ? "  ⚠️ NOT recommended unless you are certain. If you MUST compress this, pass `dangerous: true`." : ""

        if (e.protectedTokens > 0 && e.compressibleTokens === 0) {
            return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${fmt(e.tokens)} [PROTECTED: ${e.protectedTools.join(", ")} — not compressible]${suffix}`
        }

        if (e.protectedTokens > 0 && e.compressibleTokens > 0) {
            return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${fmt(e.tokens)} [${fmt(e.compressibleTokens)} compressible | ${fmt(e.protectedTokens)} protected: ${e.protectedTools.join(", ")}]${suffix}`
        }

        return `  ${e.startRef}–${e.endRef}  ${e.count} msgs  ${fmt(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${suffix}`
    })

    return `Compressible ranges (oldest first):\n${lines.join("\n")}`
}

/**
 * Compute the set of protected message refs (mNNNNN) that should be excluded
 * from compression recommendations. Combines two rules:
 *   1. Last N messages (preserveRecentMessages, default 5)
 *   2. Last N tokens expanding backward (preserveRecentTokens, default 5000)
 *
 * Note: preserveLastUserMessage is no longer handled here (moved to soft
 * filtering in the compress pipeline — see filterLastUserMessage). The last
 * user message is filtered from the compress plan instead of causing a hard
 * rejection.
 *
 * Only considers visible, non-synthetic, non-pruned messages.
 */
export function computeProtectedRefs(
    messages: WithParts[],
    state: SessionState,
    compress: PluginConfig["compress"],
): Set<string> {
    if (compress.lastSegmentSoftBlock === false) return new Set()

    const preserveN = compress.preserveRecentMessages ?? 5
    const preserveTokens = compress.preserveRecentTokens ?? 5000

    const result = new Set<string>()

    const visible: { ref: string; tokens: number; isUser: boolean }[] = []
    for (const msg of messages) {
        if (isSyntheticMessage(msg)) continue
        if (isIgnoredUserMessage(msg)) continue
        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (!ref) continue
        if (state.prune.messages.byMessageId.has(msg.info.id)) continue

        let tokens = 0
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
            } else if (part.type !== "text" && part.type !== "reasoning") {
                tokens += Math.round(JSON.stringify(part).length / 4)
            }
        }
        visible.push({ ref, tokens, isUser: msg.info.role === "user" })
    }

    if (preserveN > 0) {
        for (const m of visible.slice(-preserveN)) {
            result.add(m.ref)
        }
    }

    if (preserveTokens > 0) {
        let tokenAccum = 0
        for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
            result.add(visible[i]!.ref)
            tokenAccum += visible[i]!.tokens
        }
    }

    return result
}

/**
 * Filter compressible ranges to exclude those overlapping the protected zone.
 * Since the protected zone is always at the tail of the conversation, a range
 * whose startRef or endRef is protected is partially or fully within the zone.
 * Compressing such a range would either be rejected by the enforcement check
 * or waste model effort — exclude it preemptively.
 */
export function excludeProtectedRanges(
    ranges: CompressibleRange[],
    protectedRefs: Set<string>,
): CompressibleRange[] {
    if (protectedRefs.size === 0) return ranges
    return ranges.filter(
        (r) => !protectedRefs.has(r.startRef) && !protectedRefs.has(r.endRef),
    )
}
