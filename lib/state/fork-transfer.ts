/**
 * Fork-recovery: transfer ACP compression state from a parent session to a fork.
 *
 * When OpenCode forks a session, the fork gets a new session ID and a copy of
 * the parent's messages with regenerated raw IDs. If that copy strips the
 * historical `compress` tool inputs (a common fork-copy behavior), the replay
 * path in `rebuild.ts` reconstructs zero blocks and the copied raw parent
 * history stays visible → context overflow (issue #375).
 *
 * This module instead loads the PARENT's persisted ACP state and transfers its
 * compression blocks to the fork, translating parent raw message IDs to the
 * fork's new raw IDs across the copied shared prefix.
 *
 * The parent→fork mapping is built by matching the two (filtered) message
 * lists on position + `time.created` + role. Those attributes are preserved
 * across a fork copy (only raw IDs change), so the mapping is robust to the
 * one-ref shift that forks get from being misclassified as sub-agents
 * (`isSubAgentSession` → `parentID` set → `assignMessageRefs` skips the first
 * user message). A naive ref-to-ref translation would point blocks at the
 * wrong messages; this approach does not.
 *
 * The transfer produces INDEPENDENT fork-local state:
 *  - parent nudge cadence / current-turn state is NOT inherited;
 *  - the parent state is never mutated (it is only read);
 *  - block IDs are preserved, so internal block references (included/consumed/
 *    parent) and `bN` boundary refs remain valid.
 *
 * If the parent state is unavailable, the shared prefix cannot be established,
 * or no block is translatable, the function returns 0 so the caller falls back
 * to the historical replay path.
 */

import type { Logger } from "../logger"
import { assignMessageRefs, parseBoundaryId } from "../message-ids"
import { filterMessages } from "../messages/shape"
import { isSyntheticMessage } from "../messages/query"
import { loadSessionState } from "./persistence"
import { loadPruneMessagesState } from "./utils"
import type { CompressionBlock, PrunedMessageEntry, SessionState, WithParts } from "./types"

interface MessageIdentity {
    id: string
    role: string
    created: number
}

function extractIdentity(message: WithParts): MessageIdentity | null {
    const id = message?.info?.id
    if (typeof id !== "string" || id.length === 0) {
        return null
    }
    if (isSyntheticMessage(message)) {
        return null
    }
    const role = message.info.role
    const created = message.info.time?.created
    if (typeof created !== "number") {
        return null
    }
    return { id, role, created }
}

/**
 * Build a parent-raw-ID → fork-raw-ID mapping over the copied shared prefix.
 *
 * Both lists are reduced to well-formed, non-synthetic messages and matched by
 * position; the match stops at the first position where `time.created` or role
 * diverges. A fork copies the parent's prefix in order, so positional
 * alignment is correct up to the divergence point.
 */
function buildSharedPrefixMapping(
    parentMessages: WithParts[],
    forkMessages: WithParts[],
): Map<string, string> {
    const parentIds = parentMessages
        .map(extractIdentity)
        .filter((x): x is MessageIdentity => x !== null)
    const forkIds = forkMessages
        .map(extractIdentity)
        .filter((x): x is MessageIdentity => x !== null)

    const mapping = new Map<string, string>()
    const limit = Math.min(parentIds.length, forkIds.length)
    for (let i = 0; i < limit; i++) {
        const p = parentIds[i]
        const f = forkIds[i]
        if (p.created === f.created && p.role === f.role) {
            mapping.set(p.id, f.id)
        } else {
            break
        }
    }
    return mapping
}

/**
 * Re-map a boundary ref (mNNNNN or bN) from the parent's ref space to the
 * fork's ref space. Block refs (bN) are preserved — block IDs are unchanged
 * across the transfer. Message refs are resolved through the raw-ID mapping.
 *
 * Best-effort: when the boundary message's fork raw id has no ref — which only
 * happens for the fork's first user message when the fork is classified as a
 * sub-agent and `assignMessageRefs` skips it — the original parent ref is kept.
 * `startId`/`endId` are metadata (dedup key, GC-merge boundary, display); core
 * pruning is `byMessageId`-based and is unaffected by this fallback.
 */
function remapBoundaryRef(
    ref: string,
    mapping: Map<string, string>,
    forkByRawId: Map<string, string>,
    parentByRef: Map<string, string>,
): string {
    const parsed = parseBoundaryId(ref)
    if (!parsed) {
        return ref
    }
    if (parsed.kind === "compressed-block") {
        return parsed.ref
    }
    // kind === "message"
    const parentRawId = parentByRef.get(parsed.ref)
    if (!parentRawId) {
        return ref
    }
    const forkRawId = mapping.get(parentRawId)
    if (!forkRawId) {
        return ref
    }
    const forkRef = forkByRawId.get(forkRawId)
    return forkRef ?? ref
}

/**
 * Translate a single parent block to fork raw IDs. Returns null when the block
 * cannot be placed in the fork (its anchor or compress message is not in the
 * shared prefix).
 */
function translateBlock(
    block: CompressionBlock,
    mapping: Map<string, string>,
    forkByRawId: Map<string, string>,
    parentByRef: Map<string, string>,
): CompressionBlock | null {
    const anchorForkId = mapping.get(block.anchorMessageId)
    if (!anchorForkId) {
        return null
    }
    const compressForkId = mapping.get(block.compressMessageId)
    if (!compressForkId) {
        return null
    }

    const translateList = (ids: string[]): string[] =>
        ids.map((id) => mapping.get(id)).filter((id): id is string => id !== undefined)

    // directToolIds / effectiveToolIds hold tool CALL ids (part.callID), not message
    // ids. Call ids are preserved verbatim across a fork copy, so they must NOT be
    // run through the message-id mapping (doing so would drop every entry).
    const preserveList = (ids: string[]): string[] => [...new Set(ids)]

    return {
        ...block,
        anchorMessageId: anchorForkId,
        compressMessageId: compressForkId,
        directMessageIds: translateList(block.directMessageIds),
        effectiveMessageIds: translateList(block.effectiveMessageIds),
        directToolIds: preserveList(block.directToolIds),
        effectiveToolIds: preserveList(block.effectiveToolIds),
        startId: remapBoundaryRef(block.startId, mapping, forkByRawId, parentByRef),
        endId: remapBoundaryRef(block.endId, mapping, forkByRawId, parentByRef),
    }
}

/**
 * Translate the parent's byMessageId entries to fork raw IDs, keeping only
 * entries whose message is in the shared prefix and whose block references
 * survived the block translation.
 */
function translateByMessageId(
    parentByMessageId: Record<string, PrunedMessageEntry>,
    mapping: Map<string, string>,
    translatedBlockIds: Set<number>,
): Map<string, PrunedMessageEntry> {
    const result = new Map<string, PrunedMessageEntry>()
    for (const [parentMsgId, entry] of Object.entries(parentByMessageId)) {
        if (!entry || typeof entry !== "object") {
            continue
        }
        const forkMsgId = mapping.get(parentMsgId)
        if (!forkMsgId) {
            continue
        }
        const allBlockIds = (entry.allBlockIds ?? []).filter((id) => translatedBlockIds.has(id))
        const activeBlockIds = (entry.activeBlockIds ?? []).filter((id) =>
            translatedBlockIds.has(id),
        )
        result.set(forkMsgId, {
            tokenCount: typeof entry.tokenCount === "number" ? entry.tokenCount : 0,
            allBlockIds,
            activeBlockIds,
        })
    }
    return result
}

/**
 * Recover the fork's compression state from the parent's persisted ACP state.
 *
 * Returns the number of ACTIVE blocks transferred (0 when the transfer is
 * unavailable or yields nothing prunable, in which case the caller should fall
 * back to the historical replay path).
 */
export async function recoverFromParentState(
    client: any,
    state: SessionState,
    forkMessages: WithParts[],
    parentId: string,
    logger: Logger,
): Promise<number> {
    // 1. Load the parent's persisted ACP state (read-only — never mutated).
    const parentState = await loadSessionState(parentId, logger)
    if (!parentState) {
        logger.info("fork-transfer: no parent state found, falling back to replay", {
            parentId,
        })
        return 0
    }

    const parentMessagesState = parentState.prune?.messages
    const parentBlocks = parentMessagesState?.blocksById
    if (!parentBlocks) {
        logger.info("fork-transfer: parent state has no blocks, falling back to replay", {
            parentId,
        })
        return 0
    }
    const parentBlockEntries = Object.entries(parentBlocks).filter(
        ([id, block]) =>
            Number.isInteger(Number.parseInt(id, 10)) && Number.parseInt(id, 10) >= 1 && !!block,
    )
    if (parentBlockEntries.length === 0) {
        logger.info("fork-transfer: parent state has no blocks, falling back to replay", {
            parentId,
        })
        return 0
    }

    // 2. Fetch the parent's messages to establish the shared-prefix mapping.
    let parentMessages: WithParts[]
    try {
        const response = await client.session.messages({ path: { id: parentId } })
        parentMessages = filterMessages(response?.data || response)
    } catch (error: any) {
        logger.warn("fork-transfer: failed to fetch parent messages, falling back to replay", {
            parentId,
            error: error?.message || String(error),
        })
        return 0
    }

    // 3. Build the parent→fork mapping over the copied shared prefix.
    const mapping = buildSharedPrefixMapping(parentMessages, forkMessages)
    if (mapping.size === 0) {
        logger.info("fork-transfer: no shared prefix detected, falling back to replay", {
            parentId,
        })
        return 0
    }

    // 4. Assign fork refs (idempotent) so block boundary refs can be re-mapped.
    assignMessageRefs(state, forkMessages)
    const forkByRawId = state.messageIds.byRawId
    const parentByRef = new Map<string, string>(Object.entries(parentState.messageIds?.byRef ?? {}))

    // 5. Translate every parent block (active and inactive).
    const translatedBlocks = new Map<number, CompressionBlock>()
    let skipped = 0
    for (const [blockIdStr, block] of parentBlockEntries) {
        const blockId = Number.parseInt(blockIdStr, 10)
        const translated = translateBlock(block, mapping, forkByRawId, parentByRef)
        if (translated) {
            translatedBlocks.set(blockId, translated)
        } else {
            skipped++
        }
    }

    if (translatedBlocks.size === 0) {
        logger.info("fork-transfer: no blocks translatable, falling back to replay", {
            parentId,
            parentBlockCount: parentBlockEntries.length,
            mappingSize: mapping.size,
        })
        return 0
    }

    // 6. Only transfer when at least one ACTIVE block is translatable. Inactive
    //    blocks prune nothing, so if only inactive blocks survive the translation
    //    (e.g. the parent continued after the fork, so the active blocks' compress
    //    messages fall outside the copied prefix) we leave the fork's state
    //    untouched and let the caller fall back to replay — otherwise the replay
    //    would run on top of already-transferred inactive blocks.
    const activeCount = Array.from(translatedBlocks.values()).filter((b) => b.active).length
    if (activeCount === 0) {
        logger.info("fork-transfer: no active blocks translatable, falling back to replay", {
            parentId,
            recoveredBlocks: translatedBlocks.size,
            skippedBlocks: skipped,
            mappingSize: mapping.size,
        })
        return 0
    }

    // 7. Apply the translated state to the fork (independent fork-local state).
    //    loadPruneMessagesState rebuilds activeBlockIds / activeByAnchorMessageId /
    //    nextBlockId / nextRunId from the blocks, mirroring how the parent state
    //    is loaded. Nudge cadence / current-turn state are intentionally NOT copied.
    const translatedByMessageId = translateByMessageId(
        parentMessagesState.byMessageId ?? {},
        mapping,
        new Set(translatedBlocks.keys()),
    )
    state.prune.messages = loadPruneMessagesState({
        byMessageId: Object.fromEntries(translatedByMessageId),
        blocksById: Object.fromEntries(
            Array.from(translatedBlocks.entries()).map(
                ([id, block]): [string, CompressionBlock] => [String(id), block],
            ),
        ),
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
        markedForCleanup: [],
    })

    logger.info("fork-transfer: recovered compression state from parent", {
        parentId,
        recoveredBlocks: translatedBlocks.size,
        activeBlocks: activeCount,
        skippedBlocks: skipped,
        mappingSize: mapping.size,
    })

    return activeCount
}
