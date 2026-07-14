/**
 * Fork-recovery: reconstruct ACP compression state from message history.
 *
 * When a session is forked, OpenCode copies all messages (including completed
 * `compress` tool parts) but regenerates message IDs. ACP's persisted state is
 * keyed off the original session ID and original raw message IDs, so the fork
 * session starts with empty prune state → no pruning → context overflow.
 *
 * This module replays historical `compress` tool invocations in chronological
 * order, rebuilding `CompressionBlock`s / `byMessageId` / `activeByAnchorMessageId`
 * using the fork's NEW raw IDs. Because message refs (mNNNNN) are assigned
 * sequentially by message order, they are fork-stable: a ref in a compress
 * input points to the same logical message in both original and fork.
 *
 * The rebuilt state is an approximation: protected-content enrichments that
 * were appended to summaries at original-compress-time are not re-derived
 * (only the raw model summary from the tool input is available). This is
 * acceptable — protected tool outputs survive in visible context anyway, and
 * the primary goal (pruning compressed messages to avoid overflow) is met.
 */
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { assignMessageRefs } from "../message-ids"
import { buildSearchContext, resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "../compress/search"
import { filterProtectedToolMessages } from "../compress/protected-content"
import { resolveRanges } from "../compress/range-utils"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "../compress/state"
import { countTokens } from "../token-utils"
import type {
    BoundaryReference,
    CompressRangeToolArgs,
    CompressRangeEntry,
    CompressMessageToolArgs,
    CompressMessageEntry,
    SearchContext,
    SelectionResolution,
} from "../compress/types"
import type { SessionState, WithParts } from "./types"

interface CompressInvocation {
    messageId: string
    callId: string | undefined
    input: unknown
}

function collectCompressInvocations(messages: WithParts[]): CompressInvocation[] {
    const invocations: CompressInvocation[] = []
    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || part.tool !== "compress") {
                continue
            }
            if (part.state?.status !== "completed") {
                continue
            }

            const input = part.state?.input
            if (!input || typeof input !== "object") {
                continue
            }

            invocations.push({
                messageId: message.info.id,
                callId: typeof part.callID === "string" ? part.callID : undefined,
                input,
            })
        }
    }
    return invocations
}

/** Range-mode entries have `startId`/`endId`; message-mode entries have `messageId`. */
function isRangeInput(input: any): boolean {
    const content = Array.isArray(input?.content) ? input.content : []
    const first = content[0]
    return !!first && typeof first.startId === "string"
}

function extractBoundaryConsumedBlocks(
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): number[] {
    const consumed: number[] = []
    const seen = new Set<number>()
    for (const ref of [startReference, endReference]) {
        if (ref.kind === "compressed-block" && ref.blockId !== undefined && !seen.has(ref.blockId)) {
            seen.add(ref.blockId)
            consumed.push(ref.blockId)
        }
    }
    return consumed
}

function dedupeBlockIds(ids: number[]): number[] {
    const seen = new Set<number>()
    const result: number[] = []
    for (const id of ids) {
        if (!Number.isInteger(id) || id <= 0) continue
        if (seen.has(id)) continue
        seen.add(id)
        result.push(id)
    }
    return result
}

/**
 * Replay a single range-mode compress invocation.
 * Mirrors `createCompressRangeTool.execute` (lib/compress/range.ts):
 *   resolveRanges → filterProtectedToolMessages → per-entry block allocation.
 *
 * Returns the number of blocks created.
 */
function rebuildRangeInvocation(
    state: SessionState,
    input: CompressRangeToolArgs,
    searchContext: SearchContext,
    invocation: CompressInvocation,
    protectedTools: string[],
    protectedFilePatterns: string[],
    logger: Logger,
): number {
    // Resolve ALL entries against the pre-invocation state (mirrors range.ts:
    // resolveRanges runs before any block from this call is created).
    const plans = resolveRanges(input, searchContext, state)

    const runId = allocateRunId(state)
    let created = 0

    for (const plan of plans) {
        // [Bug 39] Hard-exclude protected tool messages so they survive in
        // visible context instead of being pruned.
        const filteredSelection = filterProtectedToolMessages(
            plan.selection,
            searchContext,
            protectedTools,
            protectedFilePatterns,
        )
        if (filteredSelection.messageIds.length === 0) {
            continue
        }

        // Auto-detect consumed blocks: requiredBlockIds (active blocks whose
        // anchor falls in range) + boundary blocks (when start/end is a bN ref).
        const boundaryConsumed = extractBoundaryConsumedBlocks(
            filteredSelection.startReference,
            filteredSelection.endReference,
        )
        const consumedBlockIds = dedupeBlockIds([
            ...filteredSelection.requiredBlockIds,
            ...boundaryConsumed,
        ])

        const blockId = allocateBlockId(state)
        const storedSummary = wrapCompressedSummary(blockId, plan.entry.summary)
        const summaryTokens = countTokens(storedSummary)

        applyCompressionState(
            state,
            {
                topic: input.topic,
                batchTopic: input.topic,
                startId: plan.entry.startId,
                endId: plan.entry.endId,
                mode: "range",
                runId,
                compressMessageId: invocation.messageId,
                compressCallId: invocation.callId,
                summaryTokens,
            },
            filteredSelection,
            plan.anchorMessageId,
            blockId,
            storedSummary,
            consumedBlockIds,
        )
        created++
    }

    return created
}

/** Mirrors `resolveMessage` (lib/compress/message-utils.ts) but skips invalid
 *  entries gracefully instead of throwing. */
function resolveMessageEntry(
    entry: CompressMessageEntry,
    searchContext: SearchContext,
    state: SessionState,
): { selection: SelectionResolution; anchorMessageId: string } | null {
    const normalizedRef = entry.messageId.trim()
    if (normalizedRef.toUpperCase() === "BLOCKED") {
        return null
    }

    const ref = normalizedRef.toLowerCase()
    if (!/^m\d{4,5}$/.test(ref)) {
        return null
    }

    const messageId = state.messageIds.byRef.get(ref)
    if (!messageId) {
        return null
    }
    if (!searchContext.rawMessagesById.has(messageId)) {
        return null
    }

    try {
        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            ref,
            ref,
        )
        const selection = resolveSelection(searchContext, startReference, endReference)
        return {
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    } catch {
        return null
    }
}

/**
 * Replay a single message-mode compress invocation.
 * Mirrors `createCompressMessageTool.execute` (lib/compress/message.ts):
 *   per-entry resolve → block allocation with consumedBlockIds = [].
 *
 * Returns the number of blocks created.
 */
function rebuildMessageInvocation(
    state: SessionState,
    input: CompressMessageToolArgs,
    searchContext: SearchContext,
    invocation: CompressInvocation,
): number {
    const runId = allocateRunId(state)
    let created = 0

    for (const entry of input.content) {
        const resolved = resolveMessageEntry(entry, searchContext, state)
        if (!resolved) {
            continue
        }

        const blockId = allocateBlockId(state)
        const storedSummary = wrapCompressedSummary(blockId, entry.summary)
        const summaryTokens = countTokens(storedSummary)

        applyCompressionState(
            state,
            {
                topic: entry.topic,
                batchTopic: input.topic,
                startId: entry.messageId,
                endId: entry.messageId,
                mode: "message",
                runId,
                compressMessageId: invocation.messageId,
                compressCallId: invocation.callId,
                summaryTokens,
            },
            resolved.selection,
            resolved.anchorMessageId,
            blockId,
            storedSummary,
            [],
        )
        created++
    }

    return created
}

/**
 * Reconstruct compression state by replaying historical `compress` tool
 * invocations from message history. Called when no persisted state exists
 * (fork scenario).
 *
 * @returns number of compression blocks reconstructed.
 */
export function rebuildCompressionState(
    state: SessionState,
    messages: WithParts[],
    config: PluginConfig,
    logger: Logger,
): number {
    // Assign refs first so boundary resolution can map mNNNNN → rawId.
    // (In the normal pipeline this runs later in hooks.ts; calling it here
    // is idempotent — the later call is a no-op.)
    assignMessageRefs(state, messages)

    const invocations = collectCompressInvocations(messages)
    if (invocations.length === 0) {
        return 0
    }

    const protectedTools = config.compress.protectedTools
    const protectedFilePatterns = config.protectedFilePatterns

    let rebuilt = 0

    for (const invocation of invocations) {
        // Rebuild search context each iteration so blocks created by earlier
        // invocations are visible (needed for nested bN boundary resolution).
        const searchContext = buildSearchContext(state, messages)

        try {
            if (isRangeInput(invocation.input)) {
                rebuilt += rebuildRangeInvocation(
                    state,
                    invocation.input as CompressRangeToolArgs,
                    searchContext,
                    invocation,
                    protectedTools,
                    protectedFilePatterns,
                    logger,
                )
            } else {
                rebuilt += rebuildMessageInvocation(
                    state,
                    invocation.input as CompressMessageToolArgs,
                    searchContext,
                    invocation,
                )
            }
        } catch (err: any) {
            logger.warn("rebuild: failed to replay compress invocation, skipping", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }

    if (rebuilt > 0) {
        logger.info(`rebuild: reconstructed ${rebuilt} compression block(s) from history`)
    }

    return rebuilt
}
