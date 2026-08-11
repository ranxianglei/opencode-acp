import type { PruneMessagesState, SessionState, SessionStats, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage, isSyntheticMessage } from "../messages/query"
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
}

export function snapshotCompressionState(state: SessionState): CompressionSnapshot {
    return {
        messages: structuredClone(state.prune.messages),
        stats: { ...state.stats },
    }
}

export function restoreCompressionState(state: SessionState, snapshot: CompressionSnapshot): void {
    state.prune.messages = structuredClone(snapshot.messages)
    state.stats = { ...snapshot.stats }
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
        ctx.config,
    )

    assignMessageRefs(ctx.state, rawMessages)

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
            const metrics = Object.fromEntries(failure.result.metrics.map((m) => [m.name, m.value]))
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
 * Per-phantom diagnostics used in error / skip-notice messages (issue #290).
 */
export interface PhantomPlanDetail {
    /** 0-based index in the input plans array. */
    index: number
    /** Sample of message IDs in the effective set that are already compressed. */
    consumedMessageIds: string[]
    /** Block IDs owning those messages (sorted ascending). */
    owningBlockIds: number[]
}

export interface PhantomIdentification {
    /** Indices of plans that are phantom (no new messages to compress). */
    phantomIndices: number[]
    /** Per-phantom diagnostics for error / skip-notice messages. */
    details: PhantomPlanDetail[]
}

/**
 * Identify which plans in a batch are phantom (would produce 0 new compressed
 * messages). Stateless pre-check mirroring applyCompressionState's
 * newlyCompressedMessageIds computation: a message is "new" iff it has no
 * byMessageId entry OR its activeBlockIds is empty.
 *
 * Returns per-plan diagnostics so callers can implement partial-failure
 * batches (issue #290 fix A): skip phantom entries, compress the valid ones,
 * and report which entries / IDs / blocks conflicted (fix C).
 *
 * Multi-consumed single-tier carve-out: a higher-tier distillation that merges
 * sibling blocks of the SAME tier is allowed even when every message is
 * already active under those siblings (the merge itself is the value).
 * Matches the historical exception in checkPhantomBlock.
 *
 * Fix for issue #93/#290: empty compression blocks waste context (summary
 * overhead with no token savings) and cause compression loops.
 */
export function identifyPhantomPlans(
    state: SessionState,
    plans: Array<{ messageIds: string[]; consumedBlockIds: number[] }>,
): PhantomIdentification {
    const phantomIndices: number[] = []
    const details: PhantomPlanDetail[] = []

    for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]
        if (!plan) continue

        // Build effective message set: selection messages + inherited from
        // consumed blocks (mirrors applyCompressionState).
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

        if (hasNew) continue

        // Multi-consumed single-tier exception (T2+ distillation merging
        // same-tier sibling blocks) — not phantom.
        if (plan.consumedBlockIds.length >= 2) {
            const tiers = new Set(
                plan.consumedBlockIds.map(
                    (id) => state.prune.messages.blocksById.get(id)?.tier ?? 1,
                ),
            )
            if (tiers.size === 1) continue
        }

        phantomIndices.push(i)

        const consumedMessageIds: string[] = []
        const owningBlockIds = new Set<number>()
        for (const mid of effective) {
            const entry = state.prune.messages.byMessageId.get(mid)
            if (entry && entry.activeBlockIds.length > 0) {
                consumedMessageIds.push(mid)
                for (const bid of entry.activeBlockIds) owningBlockIds.add(bid)
            }
        }
        details.push({
            index: i,
            consumedMessageIds: consumedMessageIds.slice(0, 8),
            owningBlockIds: [...owningBlockIds].sort((a, b) => a - b),
        })
    }

    return { phantomIndices, details }
}

export function buildPhantomErrorMessage(details: PhantomPlanDetail[]): string {
    const lines = details.map((d) => {
        const ids =
            d.consumedMessageIds.length > 0
                ? d.consumedMessageIds.join(", ")
                : "(empty effective set)"
        const blocks =
            d.owningBlockIds.length > 0
                ? d.owningBlockIds.map((b) => `b${b}`).join(", ")
                : "(no active block — likely a stale ref)"
        return `  • Entry ${d.index + 1}: all messages already compressed. Consumed IDs (sample): ${ids}. Owning block(s): ${blocks}.`
    })
    const noun = details.length === 1 ? "One compress entry" : `${details.length} compress entries`
    return (
        `${noun} contain only already-compressed messages (0 new direct messages, 0 tokens saved):\n` +
        lines.join("\n") +
        `\nNothing to compress in those entries — pick ranges with visible, uncompressed content. ` +
        `Use \`acp_status({scope:"uncompressed"})\` to see which ranges are still compressible.`
    )
}

/**
 * Outcome of classifying a batch against its phantom identification (issue #290).
 * - `clean`: no phantom entries — compress everything.
 * - `all-phantom`: every entry is phantom — caller throws via {@link buildPhantomErrorMessage}.
 * - `partial`: some entries are phantom — caller drops `dropIndices`, compresses the rest,
 *   and surfaces `notice` in the success return.
 */
export type PhantomPartition =
    | { kind: "clean" }
    | { kind: "all-phantom"; details: PhantomPlanDetail[] }
    | { kind: "partial"; dropIndices: number[]; details: PhantomPlanDetail[]; notice: string }

/**
 * Partition a batch of plans based on its phantom identification. Pure helper
 * extracted so the all-vs-some-vs-clean decision and skip-notice construction
 * are independently unit-testable (issue #290 review concern C1).
 *
 * @param identification Result of {@link identifyPhantomPlans}.
 * @param totalPlans     Count of plans in the batch (before any filtering).
 */
export function partitionPhantomPlans(
    identification: PhantomIdentification,
    totalPlans: number,
): PhantomPartition {
    if (identification.phantomIndices.length === 0) {
        return { kind: "clean" }
    }
    if (identification.phantomIndices.length === totalPlans) {
        return { kind: "all-phantom", details: identification.details }
    }
    return {
        kind: "partial",
        dropIndices: identification.phantomIndices,
        details: identification.details,
        notice: buildPhantomSkipNotice(identification),
    }
}

/**
 * Build the concise skip-notice shown when a partial batch drops phantom entries
 * (issue #290 fix A — model-facing success return).
 */
export function buildPhantomSkipNotice(identification: PhantomIdentification): string {
    const skippedNums = identification.details.map((d) => `#${d.index + 1}`).join(", ")
    const noun = identification.phantomIndices.length === 1 ? "entry" : "entries"
    return (
        `Skipped ${identification.phantomIndices.length} already-compressed ${noun} (${skippedNums}) ` +
        `— they are no-ops; the remaining entries were compressed.`
    )
}

/**
 * Stateless check: reject compression plans that would produce phantom blocks
 * (0 new direct messages, 0 compressed tokens). A phantom block occurs when
 * every message in the effective range is already active under an existing
 * compression block. Returns an Error for the FIRST phantom plan, or null.
 *
 * Legacy single-error API — kept for backward compatibility. Batch-aware
 * callers should use {@link identifyPhantomPlans} + {@link buildPhantomErrorMessage}
 * to implement partial-failure batches (issue #290 fix A).
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
    const { details } = identifyPhantomPlans(state, plans)
    if (details.length === 0) return null
    const first = details[0]!
    return new Error(
        `Compression range ${first.index + 1} contains only already-compressed messages ` +
            "(0 new direct messages, 0 tokens saved). Nothing to compress — " +
            'pick a range with visible, uncompressed content. Use `acp_status({scope:"uncompressed"})` ' +
            "to see which ranges are still compressible.",
    )
}

/**
 * Compute the set of protected message raw IDs based on recent-message and
 * recent-token rules. These IDs cannot be included in a compression plan
 * unless the caller passes `dangerous: true`.
 *
 * Note: preserveLastUserMessage is handled by soft filtering in the compress
 * pipeline (filterLastUserMessage), not here.
 */
export function computeProtectedRawIds(
    rawMessages: WithParts[],
    state: SessionState,
    compress: import("../config").CompressConfig,
): Set<string> {
    const preserveN = compress.preserveRecentMessages ?? 5
    const preserveTokens = compress.preserveRecentTokens ?? 5000

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

    return result
}

/**
 * Reject compression plans that cover protected messages (last N messages
 * or last N tokens). The caller must pass `dangerous: true` to proceed.
 * Returns an Error to throw if the caller did not opt in.
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
    const nToks = ctx.config.compress.preserveRecentTokens ?? 5000
    return new Error(
        `This range includes ${coveredProtected.length} protected recent message(s) (${sample}), ` +
            "which are likely still needed for the current task step.\n\n" +
            `Protected zone: last ${nMsgs} messages + last ${nToks >= 1000 ? `${nToks / 1000}K` : nToks} tokens.\n` +
            "If you are certain this content is genuinely consumed and must be compressed, " +
            "re-issue the call with `dangerous: true`.\n" +
            "Otherwise, compress older ranges that do not include the tail of the conversation.",
    )
}
