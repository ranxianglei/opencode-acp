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
 * Stateless check: if any plan covers the most recent visible message,
 * the caller must pass `dangerous: true` to proceed. Returns an Error
 * to throw if the caller did not opt in.
 */
export function checkLastSegmentDangerous(
    ctx: ToolContext,
    allPlanMessageIds: string[][],
    rawMessages: WithParts[],
    dangerous: boolean,
): Error | null {
    if (ctx.config.compress.lastSegmentSoftBlock === false) return null

    const lastVisibleId = getLastVisibleMessageId(rawMessages, ctx.state)
    if (!lastVisibleId) return null

    const coversLast = allPlanMessageIds.some((ids) => ids.includes(lastVisibleId))
    if (!coversLast) return null

    if (dangerous) return null

    return new Error(
        `This range includes the most recent message (${lastVisibleId}), which is likely still needed for the current task step.\n\n` +
            `If you are certain this content is genuinely consumed and must be compressed, re-issue the call with \`dangerous: true\`.\n` +
            `Otherwise, compress older ranges that do not include the tail of the conversation.`,
    )
}
