import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag, formatTokenSize, classifyMessageType } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import { countMessageCharacters } from "../../token-utils"
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
    buildCompressibleRanges,
    buildContextUsageGuidance,
    computeShouldNudge,
    countMessagesAfterIndex,
    estimateContextComposition,
    findLastNonIgnoredMessage,
    formatCompressibleRanges,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
    resolveAdaptiveNudgeGrowth,
} from "./utils"
import { buildCompressedBlockGuidance } from "../../prompts/extensions/nudge"
import { HOW_TO_COMPRESS_RULES, COMPRESS_PHILOSOPHY } from "../../prompts/compression-rules"

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
    debugNotify?: (text: string) => void,
    preCompressTokens?: number,
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

    const lastUserIdx = messages.findLastIndex(
        (m) => m.info.role === "user" && !isIgnoredUserMessage(m),
    )
    const currentTurnStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0
    const currentTurnHasCompress = messages
        .slice(currentTurnStart)
        .some((m) => m.info.role === "assistant" && messageHasCompress(m))

    if (currentTurnHasCompress) {
        const wasNudgeTriggered = state.nudges.lastNudgeShownTokens !== undefined

        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        state.nudges.lastNudgeShownTokens = undefined
        state.nudges.lastToolOutputNudgeTokens = undefined

        // Proportional baseline adjustment: if nudge-triggered compress, adjust
        // baseline by how much was actually compressed. >50% of growth compressed
        // → full baseline update. 20-30% → partial update. This prevents both
        // baseline leak (small compress → full reset → growth forgotten) and
        // over-compression (model gets re-nudged too soon after a small compress).
        //
        // Voluntary compress (no nudge shown) keeps the original baseline entirely.
        if (wasNudgeTriggered && !state.nudges.compressBaselineSet) {
            const baseline = state.nudges.lastPerMessageNudgeTokens
            const postCompress = currentTokens
            // preCompressTokens is captured in hooks.ts BEFORE prune() runs
            const preCompress = preCompressTokens

            if (
                baseline !== undefined &&
                postCompress !== undefined &&
                preCompress !== undefined &&
                preCompress > postCompress
            ) {
                const growth = preCompress - baseline
                const compressed = preCompress - postCompress
                if (growth > 0 && compressed > 0) {
                    const ratio = Math.min(1, compressed / growth)
                    const adjustment = Math.min(1, ratio * 2) // 50%→1.0, 25%→0.5, 10%→0.2
                    const newBaseline =
                        baseline + Math.round((postCompress - baseline) * adjustment)
                    state.nudges.lastPerMessageNudgeTokens = newBaseline
                } else {
                    state.nudges.lastPerMessageNudgeTokens = postCompress
                }
            } else {
                state.nudges.lastPerMessageNudgeTokens = postCompress
            }
            state.nudges.compressBaselineSet = true
        }

        saveSessionState(state, logger).catch(() => {})
        return
    }

    // New turn (no compress) — release the lock
    state.nudges.compressBaselineSet = false

    let anchorsChanged = false
    let baselineReEstablished = false
    let baselineCorrected = false

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


    const nudgeGrowthTokens =
        config.compress?.nudgeGrowthTokens ?? resolveAdaptiveNudgeGrowth(modelContextLimit)

    // ── Growth floor gate (anti-thrashing) ──────────────────────────────
    // Nudge output is suppressed unless context grew by at least growthFloor
    // tokens since the last nudge baseline. Prevents re-nudging every turn
    // after a small compress or when anchors accumulate with negligible growth.
    //
    //   growthFloor = max(minNudgeGrowthFloor, minNudgeGrowthRatio × nudgeGrowthTokens)
    //     1M model:   max(5000, 0.45×50000) = 22500
    //     100K model: max(5000, 0.45×6000)  = 5000
    //
    // Only bypassed at emergencyThresholdPercent (default 98%) — near-overflow
    // always fires regardless of growth.
    const growthFloor = Math.max(
        config.compress?.minNudgeGrowthFloor ?? 5000,
        (config.compress?.minNudgeGrowthRatio ?? 0.45) * nudgeGrowthTokens,
    )
    const emergencyThreshold = resolveEmergencyThreshold(config, modelContextLimit)
    const emergencyOverride =
        emergencyThreshold !== undefined &&
        currentTokens !== undefined &&
        currentTokens >= emergencyThreshold

    if (
        currentTokens !== undefined &&
        state.nudges.lastPerMessageNudgeTokens !== undefined &&
        currentTokens < state.nudges.lastPerMessageNudgeTokens - nudgeGrowthTokens
    ) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        state.nudges.lastNudgeShownTokens = undefined
        baselineCorrected = true
    }

    const hasPendingNudge = state.nudges.lastNudgeShownTokens !== undefined
    const effectiveThreshold = hasPendingNudge
        ? Math.floor(nudgeGrowthTokens / 2)
        : nudgeGrowthTokens
    const growthReference =
        state.nudges.lastNudgeShownTokens ?? state.nudges.lastPerMessageNudgeTokens

    const decision = computeShouldNudge({
        currentTokens,
        modelContextLimit,
        overMinLimit,
        overMaxLimit,
        lastNudgeTokens: growthReference,
        minNudgeContextPercent: config.compress?.minNudgeContextPercent ?? 15,
        nudgeGrowthTokens: effectiveThreshold,
    })

    const growthSinceBaseline =
        currentTokens !== undefined && growthReference !== undefined
            ? currentTokens - growthReference
            : undefined
    const nudgeAllowed =
        emergencyOverride ||
        (decision.shouldNudge &&
            growthSinceBaseline !== undefined &&
            growthSinceBaseline >= growthFloor)

    state.nudges.shouldInjectThisTurn = nudgeAllowed

    const effectiveTipsVariant = emergencyOverride ? "maxLimit" : decision.tipsVariant

    if (nudgeAllowed) {
        applyAnchoredNudges(state, config, messages, prompts, compressionPriorities, currentTokens, modelContextLimit, suffixMessage)
    }

    if (state.nudges.lastPerMessageNudgeTokens === undefined && currentTokens !== undefined) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        baselineReEstablished = true
    }

    const composition = estimateContextComposition(
        messages,
        state,
        config.compress.protectedTools,
        config.protectedFilePatterns,
    )

    let tipsText: string | null = null

    if (nudgeAllowed) {
        injectContextUsage(suffixMessage, config, currentTokens, modelContextLimit)

        if (suffixMessage && composition.total > 0) {
            const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
            const pct = (n: number) =>
                n > 0 ? Math.max(1, Math.round((n / composition.total) * 100)) : 0
            const growth =
                currentTokens !== undefined && state.nudges.lastPerMessageNudgeTokens !== undefined
                    ? currentTokens - state.nudges.lastPerMessageNudgeTokens
                    : 0
            const growthStr = growth > 0 ? ` (+${fmt(growth)} since last nudge)` : ""

            const plainTextTokens = composition.textTokens
            // Soft nudges (growth/min-limit) are efficiency prompts, not overflow
            // warnings — a separate, stronger alert fires at maxLimit (below).
            const efficiencyNote = effectiveTipsVariant !== "maxLimit"
                ? `\nThis is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\n${COMPRESS_PHILOSOPHY}`
                : ""
            let breakdown = `${efficiencyNote}\nBreakdown: ${fmt(composition.toolTokens)} tool (${pct(composition.toolTokens)}%) | ${fmt(composition.summaryTokens)} summaries (${pct(composition.summaryTokens)}%) | ${fmt(composition.codeTokens)} code (${pct(composition.codeTokens)}%) | ${fmt(plainTextTokens)} text (${pct(plainTextTokens)}%)${growthStr}`

            const compressibleTokens =
                composition.total - composition.protectedTokens - composition.summaryTokens
            if (composition.protectedTokens > 0) {
                breakdown += `\n⚠️ ${fmt(composition.protectedTokens)} tokens are protected (environment-managed tools) — not compressible. Effective compressible: ~${fmt(compressibleTokens)}.`
            }

            const contextRanges = buildCompressibleRanges(
                messages,
                state,
                config.compress.protectedTools,
                config.protectedFilePatterns,
            )
            if (contextRanges.compressible.length > 0) {
                breakdown += `\n\n${formatCompressibleRanges(contextRanges.compressible, contextRanges.protected)}`
                breakdown += `\n💡 Compress all ranges in one call (pass multiple content entries: \`content: [{...}, {...}]\`).`
            }
            breakdown += `\nUse \`acp_status({scope:"uncompressed"})\` to re-fetch compressible ranges after compressing, or \`acp_status\` for compressed block details.`

            if (effectiveTipsVariant !== "maxLimit") {
                breakdown += `\n\n${HOW_TO_COMPRESS_RULES}`
            }
            appendToLastTextPart(suffixMessage, breakdown)
        }

        // maxLimit strong alert + lastNudgeShownTokens + block aging guidance
        if (effectiveTipsVariant === "maxLimit") {
            tipsText =
                '\n\n⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n{ "topic": "...", "content": [{ "startId": "<ID>", "endId": "<ID>", "summary": "..." }] }\n\nOnly use IDs from visible messages above. Compress older work first.'
        }
        // Intentionally do NOT update lastPerMessageNudgeTokens here — nudges
        // repeat every turn until the model actually compresses.
        state.nudges.lastNudgeShownTokens = currentTokens
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
    }

    if (suffixMessage) {
        // [FIX #12] Nothing injected this turn → drop the empty synthetic user
        // message. (appendToLastTextPart would no-op on "\n" anyway.)
        if (hasContent(suffixMessage)) {
            appendToLastTextPart(suffixMessage, "\n")
            if (debugNotify) {
                const text = suffixMessage.parts
                    .filter((p) => p.type === "text")
                    .map((p) => (p as any).text || "")
                    .join("\n")
                    .trim()
                if (text) {
                    debugNotify(text)
                }
            }
        } else {
            const idx = messages.lastIndexOf(suffixMessage)
            if (idx !== -1) {
                messages.splice(idx, 1)
            }
        }
    }

    // [FIX #60] Save on nudge too: a growth-triggered nudge updates the in-memory
    // baseline (above) but anchorsChanged stays false when anchor sets are
    // saturated, so the on-disk baseline went stale and the nudge refired every
    // turn after restart.
    if (anchorsChanged || nudgeAllowed || baselineReEstablished || baselineCorrected) {
        saveSessionState(state, logger).catch(() => {})
    }
}

function resolveEmergencyThreshold(
    config: PluginConfig,
    modelContextLimit: number | undefined,
): number | undefined {
    const threshold = config.compress?.emergencyThresholdPercent
    if (threshold === undefined || modelContextLimit === undefined) return undefined
    if (typeof threshold === "number") return threshold
    if (!threshold.endsWith("%")) return undefined
    const parsedPercent = parseFloat(threshold.slice(0, -1))
    if (isNaN(parsedPercent)) return undefined
    const clampedPercent = Math.max(0, Math.min(100, Math.round(parsedPercent)))
    return Math.round((clampedPercent / 100) * modelContextLimit)
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

export interface VisibleSegment {
    startRef: string
    endRef: string
    count: number
    tokens: number
    hasTool: boolean
}

function refNumber(ref: string): number {
    const n = parseInt(ref.slice(1), 10)
    return Number.isNaN(n) ? -1 : n
}

/**
 * Build disjoint visible-id segments from the surviving messages.
 *
 * Each segment is a maximal run of contiguous refs (e.g. m00003–m00007).
 * Holes between segments correspond to messages already consumed by a
 * compression block — those refs are NOT safe to target. Surfacing the
 * segments (instead of a single `first–last` span) stops the model from
 * picking a ref that lives inside a compressed hole.
 */
export function buildVisibleSegments(state: SessionState, messages: WithParts[]): VisibleSegment[] {
    const refInfo = new Map<string, { tokens: number; hasTool: boolean }>()
    for (const msg of messages) {
        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (!ref) continue
        let tokens = 0
        let hasTool = false
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
            } else if (part.type !== "text" && part.type !== "reasoning") {
                tokens += Math.round(JSON.stringify(part).length / 4)
                hasTool = true
            }
        }
        refInfo.set(ref, { tokens, hasTool })
    }
    if (refInfo.size === 0) return []

    const refs = Array.from(refInfo.keys()).sort((a, b) => refNumber(a) - refNumber(b))
    const segments: VisibleSegment[] = []
    let cur: VisibleSegment | null = null
    let prevNum = -2
    for (const ref of refs) {
        const num = refNumber(ref)
        const info = refInfo.get(ref)!
        if (cur && num === prevNum + 1) {
            cur.endRef = ref
            cur.count++
            cur.tokens += info.tokens
            if (info.hasTool) cur.hasTool = true
        } else {
            if (cur) segments.push(cur)
            cur = {
                startRef: ref,
                endRef: ref,
                count: 1,
                tokens: info.tokens,
                hasTool: info.hasTool,
            }
        }
        prevNum = num
    }
    if (cur) segments.push(cur)
    return segments
}

function formatSegment(seg: VisibleSegment): string {
    return seg.startRef === seg.endRef ? seg.startRef : `${seg.startRef}–${seg.endRef}`
}

export function formatVisibleGuidance(segments: VisibleSegment[], maxSegs: number): string {
    if (segments.length === 0) return ""
    const totalMsgs = segments.reduce((s, seg) => s + seg.count, 0)
    const totalSegs = segments.length
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

    if (totalSegs <= maxSegs) {
        return `[Visible: ${segments.map(formatSegment).join(", ")} (${totalMsgs} msg${totalMsgs === 1 ? "" : "s"}, ${totalSegs} segment${totalSegs === 1 ? "" : "s"})]`
    }
    // Keep the largest tool-bearing/high-token segments, drop the smallest,
    // but preserve ascending ref order for what gets shown.
    const keepSet = new Set(
        [...segments]
            .sort((a, b) => {
                if (a.hasTool !== b.hasTool) return a.hasTool ? -1 : 1
                return b.tokens - a.tokens
            })
            .slice(0, maxSegs),
    )
    const shown = segments.filter((s) => keepSet.has(s))
    const omitted = segments.filter((s) => !keepSet.has(s))
    const omittedTokens = omitted.reduce((sum, s) => sum + s.tokens, 0)
    const omittedMsgs = omitted.reduce((sum, s) => sum + s.count, 0)
    return `[Visible (top ${shown.length} of ${totalSegs} segments, ${totalMsgs} msgs): ${shown.map(formatSegment).join(", ")} | +${omitted.length} smaller segment${omitted.length === 1 ? "" : "s"} (~${fmt(omittedTokens)} tokens, ${omittedMsgs} msg${omittedMsgs === 1 ? "" : "s"}) omitted]`
}

function injectVisibleIdRange(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    target: WithParts | null,
): void {
    if (!target) return
    const segments = buildVisibleSegments(state, messages)
    if (segments.length === 0) return
    const maxSegs = config.compress?.maxVisibleSegments ?? 50
    const rangeTag = "\n\n" + formatVisibleGuidance(segments, maxSegs)

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
        const msgType = classifyMessageType(message.parts)
        const msgTokens = Math.round(countMessageCharacters(message) / 4)
        const tag = formatMessageIdTag(isBlockedMessage ? "BLOCKED" : messageRef, {
            priority: priority ?? undefined,
            type: msgType,
            tokens: formatTokenSize(msgTokens),
        })

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
