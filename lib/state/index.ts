import { createSessionState } from "./factory"
export { createSessionState }
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
import { applyPendingCompressionDurations } from "../compress/timing"

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

    const fresh = createSessionState()
    state.sessionId = sessionId
    state.modelContextLimit = fresh.modelContextLimit
    state.systemPromptTokens = fresh.systemPromptTokens
    state.isSubAgent = false
    state.lastCompaction = 0
    state.currentTurn = 0
    state.compressPermission = undefined
    state.prune = fresh.prune
    state.nudges = fresh.nudges
    state.stats = fresh.stats
    state.messageIds = fresh.messageIds
    state.toolParameters = fresh.toolParameters
    state.toolIdList = fresh.toolIdList
    state.subAgentResultCache = fresh.subAgentResultCache
    state.manualMode = manualModeEnabled ? "active" : false
    state.pendingManualTrigger = null

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

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted) {
        try {
            const persistedAny = persisted as any
            if (persisted.prune?.messages && typeof persisted.prune.messages === "object") {
                const { loadPruneMessagesState } = await import("./utils")
                state.prune.messages = loadPruneMessagesState(persisted.prune.messages as any)
            }
            if (persisted.stats) {
                state.stats = {
                    pruneTokenCounter: persisted.stats.pruneTokenCounter || 0,
                    totalPruneTokens: persisted.stats.totalPruneTokens || 0,
                }
            }
            if (persistedAny._persistedLastCompaction !== undefined) {
                state.lastCompaction = Math.max(state.lastCompaction, persistedAny._persistedLastCompaction)
            }
        } catch (err) {
            logger.debug("Failed to apply persisted state", { error: String(err) })
        }
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        logger.debug("Applied pending compression durations during session init", { applied })
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
