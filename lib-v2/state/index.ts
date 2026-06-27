export { createSessionState } from "./factory"
export { saveSessionState, loadSessionState, deleteSessionState, serializeState } from "./persistence"
export { cacheToolParameters, getCachedToolParameters, getAllCachedParameters, clearToolCache, removeCachedEntry } from "./tool-cache"
export { isCompacted, getActiveBlocks, getBlockByAnchor, getMessageRef, getRawIdByRef } from "./queries"
export { allocateBlock, deactivateBlock, consumeBlocks } from "./mutations/blocks"
export { markPruned, unmarkPruned, updateActiveBlockIds } from "./mutations/prune-map"
export { ageBlocks, promoteGeneration, truncateSummary } from "./mutations/gc"
export type { SessionState, CompressionBlock, PrunedMessageEntry, PruneMessagesState, Prune, WithParts, ToolParameterEntry, SessionStats } from "./types"

import type { SessionState as SessionStateType, WithParts as WithPartsType } from "./types"
import type { Logger } from "../infra/logger"
import { loadSessionState } from "./persistence"

export async function ensureSessionInitialized(
    client: unknown,
    state: SessionStateType,
    sessionId: string,
    logger: Logger,
    messages: WithPartsType[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    state.sessionId = sessionId
    state.manualMode = manualModeEnabled ? "active" : false

    try {
        const result = await (client as {
            session?: { get?: (path: { path: { id: string } }) => Promise<{ data?: { parentID?: string | null } }> }
        }).session?.get?.({ path: { id: sessionId } })
        state.isSubAgent = !!result?.data?.parentID
    } catch (err) {
        logger.debug("Failed to inspect session parent", { error: String(err) })
        state.isSubAgent = false
    }

    state.lastCompaction = findLastSummaryTimestamp(messages)

    try {
        const persisted = await loadSessionState(sessionId, logger)
        if (persisted !== null) {
            const anyState = state as unknown as {
                prune: SessionStateType["prune"]
                stats: SessionStateType["stats"]
                messageIds: SessionStateType["messageIds"]
            }
            void anyState
        }
    } catch (err) {
        logger.debug("Failed to load persisted state", { error: String(err) })
    }
}

function findLastSummaryTimestamp(messages: WithPartsType[]): number {
    let latest = 0
    for (const msg of messages) {
        if (!msg || !msg.info) continue
        if (msg.info.role === "assistant" && (msg.info as { summary?: boolean }).summary === true) {
            const created = (msg.info as { time?: { created?: number } }).time?.created ?? 0
            if (created > latest) latest = created
        }
    }
    return latest
}

export async function checkSession(
    client: unknown,
    state: SessionStateType,
    logger: Logger,
    messages: WithPartsType[],
    manualModeDefault: boolean,
): Promise<void> {
    let lastSessionId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg || !msg.info) continue
        if (msg.info.role === "user") {
            lastSessionId = (msg.info as { sessionID?: string }).sessionID ?? null
            break
        }
    }
    if (!lastSessionId) return

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        try {
            await ensureSessionInitialized(client, state, lastSessionId, logger, messages, manualModeDefault)
        } catch (err) {
            logger.error("Failed to initialize session state", { error: String(err) })
        }
    }

    state.lastCompaction = findLastSummaryTimestamp(messages)
}

export function syncToolCache(
    state: SessionStateType,
    _config: unknown,
    logger: Logger,
    messages: WithPartsType[],
): void {
    void state
    void logger
    void messages
}
