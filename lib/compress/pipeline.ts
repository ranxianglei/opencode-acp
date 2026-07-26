import type { PruneMessagesState, SessionState, SessionStats, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage, isSyntheticMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"
import { evaluateBatchQuality } from "./quality-gate"

export interface CompressionSnapshot {
    messages: PruneMessagesState
    stats: SessionStats
    manualMode: SessionState["manualMode"]
}

export function snapshotCompressionState(state: SessionState): CompressionSnapshot {
    return {
        messages: structuredClone(state.prune.messages),
        stats: { ...state.stats },
        manualMode: state.manualMode,
    }
}

export function restoreCompressionState(
    state: SessionState,
    snapshot: CompressionSnapshot,
): void {
    state.prune.messages = structuredClone(snapshot.messages)
    state.stats = { ...snapshot.stats }
    state.manualMode = snapshot.manualMode
}

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
        ctx.config,
    )

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    if (entries.length > 0) {
        const qualityReport = evaluateBatchQuality(
            ctx.state,
            rawMessages,
            entries,
            ctx.config,
            ctx.logger,
        )
        for (const failure of qualityReport.failures) {
            const metrics = Object.fromEntries(
                failure.result.metrics.map((m) => [m.name, m.value]),
            )
            ctx.logger.warn("Compression quality gate FAILED", {
                blockId: failure.blockId,
                algorithm: ctx.config.qualityGate.algorithm,
                layer: failure.result.layer,
                reason: failure.result.reason,
                ...metrics,
            })
        }
    }

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    const contextTokensBefore = getCurrentTokenUsage(ctx.state, rawMessages)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
        contextTokensBefore,
    )
}

/**
 * Find the last visible (non-synthetic, non-pruned) message ID.
 * Returns null if no visible message exists.
 */
export function getLastVisibleMessageId(
    rawMessages: WithParts[],
    state: SessionState,
): string | null {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
        const msg = rawMessages[i]
        const id = msg?.info?.id
        if (!id || typeof id !== "string") continue
        if (isSyntheticMessage(msg)) continue
        if (state.prune.messages.byMessageId.has(id)) continue
        return id
    }
    return null
}

/**
 * Stateless check: reject compression plans that would produce phantom blocks
 * (0 new direct messages, 0 compressed tokens). A phantom block occurs when
 * every message in the effective range is already active under an existing
 * compression block. Returns an Error to throw if any plan is phantom.
 *
 * Fix for issue #93: empty compression blocks waste context (summary overhead
 * with no token savings) and cause compression loops — the model sees 0 tokens
 * removed, retries the same range, creates another phantom, endlessly.
 *
 * A message is "new" (will be newly compressed) if it is NOT currently active
 * under any block. Messages active under consumed blocks are still "already
 * compressed" — re-labeling them under a new block does not newly hide them
 * (matches applyCompressionState's newlyCompressedMessageIds computation).
 */
export function checkPhantomBlock(
    state: SessionState,
    plans: Array<{ messageIds: string[]; consumedBlockIds: number[] }>,
): Error | null {
    for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]

        // Build effective message set: selection messages + inherited from
        // consumed blocks (mirrors applyCompressionState lines 79-93).
        const effective = new Set(plan.messageIds)
        for (const consumedId of plan.consumedBlockIds) {
            const block = state.prune.messages.blocksById.get(consumedId)
            if (block) {
                for (const mid of block.effectiveMessageIds) {
                    effective.add(mid)
                }
            }
        }

        const hasNew = [...effective].some((mid) => {
            const entry = state.prune.messages.byMessageId.get(mid)
            return !entry || entry.activeBlockIds.length === 0
        })

        if (!hasNew) {
            if (plan.consumedBlockIds.length >= 2) {
                const tiers = new Set(
                    plan.consumedBlockIds.map(
                        (id) => state.prune.messages.blocksById.get(id)?.tier ?? 1,
                    ),
                )
                if (tiers.size === 1) {
                    continue
                }
            }
            return new Error(
                `Compression range ${i + 1} contains only already-compressed messages ` +
                    "(0 new direct messages, 0 tokens saved). Nothing to compress — " +
                    'pick a range with visible, uncompressed content. Use `acp_status({scope:"uncompressed"})` ' +
                    "to see which ranges are still compressible.",
            )
        }
    }
    return null
}

/**
 * Compute the set of protected message raw IDs based on recent-message,
 * recent-token, and last-user-message rules. These IDs cannot be included
 * in a compression plan unless the caller passes `dangerous: true`.
 */
export function computeProtectedRawIds(
    rawMessages: WithParts[],
    state: SessionState,
    compress: import("../config").CompressConfig,
): Set<string> {
    const preserveN = compress.preserveRecentMessages ?? 20
    const preserveTokens = compress.preserveRecentTokens ?? 20000
    const preserveLastUser = compress.preserveLastUserMessage ?? true

    const result = new Set<string>()

    const visible: { id: string; tokens: number; isUser: boolean }[] = []
    for (const msg of rawMessages) {
        const id = msg?.info?.id
        if (!id || typeof id !== "string") continue
        if (isSyntheticMessage(msg)) continue
        if (isIgnoredUserMessage(msg)) continue
        if (state.prune.messages.byMessageId.has(id)) continue
        let tokens = 0
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
            } else if (part.type !== "text" && part.type !== "reasoning") {
                tokens += Math.round(JSON.stringify(part).length / 4)
            }
        }
        visible.push({ id, tokens, isUser: msg.info.role === "user" })
    }

    if (preserveN > 0) {
        for (const m of visible.slice(-preserveN)) {
            result.add(m.id)
        }
    }

    if (preserveTokens > 0) {
        let tokenAccum = 0
        for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
            result.add(visible[i]!.id)
            tokenAccum += visible[i]!.tokens
        }
    }

    if (preserveLastUser) {
        for (let i = visible.length - 1; i >= 0; i--) {
            if (visible[i]!.isUser) {
                result.add(visible[i]!.id)
                break
            }
        }
    }

    return result
}

/**
 * Reject compression plans that cover protected messages (last N messages,
 * last N tokens, or the most recent user message). The caller must pass
 * `dangerous: true` to proceed. Returns an Error to throw if the caller
 * did not opt in.
 */
export function checkProtectedRange(
    ctx: ToolContext,
    allPlanMessageIds: string[][],
    rawMessages: WithParts[],
    dangerous: boolean,
): Error | null {
    if (ctx.config.compress.lastSegmentSoftBlock === false) return null

    const protectedIds = computeProtectedRawIds(rawMessages, ctx.state, ctx.config.compress)
    if (protectedIds.size === 0) return null

    const coveredProtected: string[] = []
    for (const ids of allPlanMessageIds) {
        for (const id of ids) {
            if (protectedIds.has(id)) {
                coveredProtected.push(id)
            }
        }
    }

    if (coveredProtected.length === 0) return null
    if (dangerous) return null

    const sample = coveredProtected.slice(0, 3).join(", ")
    const nMsgs = ctx.config.compress.preserveRecentMessages ?? 20
    const nToks = ctx.config.compress.preserveRecentTokens ?? 20000
    return new Error(
        `This range includes ${coveredProtected.length} protected recent message(s) (${sample}), ` +
            "which are likely still needed for the current task step.\n\n" +
            `Protected zone: last ${nMsgs} messages + last ${nToks >= 1000 ? `${nToks / 1000}K` : nToks} tokens + most recent user message.\n` +
            "If you are certain this content is genuinely consumed and must be compressed, " +
            "re-issue the call with `dangerous: true`.\n" +
            "Otherwise, compress older ranges that do not include the tail of the conversation.",
    )
}
