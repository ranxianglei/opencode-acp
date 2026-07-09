import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { applyPendingCompressionDurations } from "../compress/timing"
import { loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    loadPruneMap,
    collectTurnNudgeAnchors,
} from "./utils"
import { getLastUserMessage } from "../messages/query"
import { parseMessageRef, formatMessageRef } from "../message-ids"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(
                client,
                state,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
            )
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        manualMode: false,
        compressPermission: undefined,
        pendingManualTrigger: null,
        prune: {
            tools: new Map<string, number>(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        subAgentResultCache: new Map<string, string>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.manualMode = false
    state.compressPermission = undefined
    state.pendingManualTrigger = null
    state.prune = {
        tools: new Map<string, number>(),
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
        lastPerMessageNudgeTurn: 0,
        lastPerMessageNudgeTokens: undefined,
        lastToolOutputNudgeTokens: undefined,
        shouldInjectThisTurn: undefined,
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.systemPromptTokens = undefined
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.nudges.lastPerMessageNudgeTurn = persisted.nudges.lastPerMessageNudgeTurn ?? 0
    state.nudges.lastPerMessageNudgeTokens = persisted.nudges.lastPerMessageNudgeTokens
    state.nudges.lastToolOutputNudgeTokens = persisted.nudges.lastToolOutputNudgeTokens
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const persistedAny = persisted as any
    if (persistedAny._persistedMessageIds) {
        state.messageIds = {
            byRawId: new Map(Object.entries(persistedAny._persistedMessageIds.byRawId || {})),
            byRef: new Map(Object.entries(persistedAny._persistedMessageIds.byRef || {})),
            nextRef: persistedAny._persistedMessageIds.nextRef || 1,
        }
        // [FIX Bug 29] Auto-cleanup stale synthetic message refs from persistence
        for (const [rawId, ref] of state.messageIds.byRawId) {
            if (rawId.startsWith("msg_dcp_summary_") || rawId.startsWith("msg_dcp_text_")) {
                state.messageIds.byRawId.delete(rawId)
                state.messageIds.byRef.delete(ref)
            }
        }
        // Migrate 4-digit refs (m0001) to 5-digit (m00001) for msgid expansion
        for (const [rawId, oldRef] of state.messageIds.byRawId) {
            const parsed = parseMessageRef(oldRef)
            if (parsed !== null) {
                const newRef = formatMessageRef(parsed)
                if (newRef !== oldRef) {
                    state.messageIds.byRawId.set(rawId, newRef)
                    state.messageIds.byRef.delete(oldRef)
                    state.messageIds.byRef.set(newRef, rawId)
                }
            }
        }
    }
    if (persistedAny._persistedLastCompaction !== undefined) {
        state.lastCompaction = Math.max(state.lastCompaction, persistedAny._persistedLastCompaction)
    }
    if (typeof persisted.modelContextLimit === "number" && persisted.modelContextLimit > 0) {
        state.modelContextLimit = persisted.modelContextLimit
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
    // [FIX Bug 1] Always save after initialization to persist messageIds + lastCompaction
    await saveSessionState(state, logger)
}
