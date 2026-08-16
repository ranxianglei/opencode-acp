import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import {
    applyPendingCompressionDurations,
    type CompressionTimingState,
    type PendingCompressionDuration,
} from "../compress/timing"
import { loadSessionState, saveSessionState } from "./persistence"
import { rebuildCompressionState } from "./rebuild"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    collectTurnNudgeAnchors,
} from "./utils"
import { parseMessageRef, formatMessageRef } from "../message-ids"

/**
 * Per-turn state update (compaction detection + turn count). Extracted from the
 * old `checkSession`; session-switch + init now live in SessionStateRegistry.
 */
export async function updatePerTurnState(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
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

// Soft cap on held sessions — guards a long-lived plugin process (daemon mode)
// from unbounded growth. Evicted sessions reload from persisted JSON on next
// access; modelContextLimit and all persisted fields survive eviction.
const REGISTRY_SOFT_CAP = 32

// [FIX #33] Per-session state. Replaces the single shared SessionState singleton
// whose resetSessionState-on-switch wiped modelContextLimit (set only by
// system.transform, which fires AFTER messages.transform) and flipped
// isSubAgent across interleaved sessions. Each session now keeps its
// own state for its lifetime — no reset-on-switch.
//
// compressionTiming is SHARED (hoisted here) rather than per-session: the `event`
// hook carries no sessionID, and a per-session map would let the event hook
// delete start entries in the wrong session (leaving the owning session
// dangling). One shared map = correct record/consume; the apply step
// iterates all sessions and only the owner matches (applied > 0).
export class SessionStateRegistry {
    private readonly states = new Map<string, SessionState>()
    readonly compressionTiming: CompressionTimingState = {
        startsByCallId: new Map<string, number>(),
        pendingByCallId: new Map<string, PendingCompressionDuration>(),
    }

    // [FIX #312] Catalog of per-model context limits, keyed `${providerID}/${modelID}`.
    // Within one LLM request the host fires experimental.chat.messages.transform
    // BEFORE experimental.chat.system.transform (sst/opencode: session/prompt.ts
    // triggers messages.transform, then llm/request.ts triggers system.transform
    // during handle.process). state.modelContextLimit is written only by the
    // system hook, so on the first request after a model switch every percentage
    // threshold (emergencyThresholdPercent, min/maxContextLimit "%", adaptive
    // nudge growth, GC tiers) is still computed against the PREVIOUS model's
    // limit. This catalog lets the messages hook reconcile against the model
    // named on the request's user message instead of waiting one turn.
    // Entries are recorded live by the system hook every request and seeded once
    // at plugin init from the host's /config/providers catalog.
    private readonly modelLimits = new Map<string, number>()

    constructor(private readonly logger: Logger) {}

    recordModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void {
        if (!providerId || !modelId || typeof limit !== "number" || limit <= 0) return
        this.modelLimits.set(`${providerId}/${modelId}`, limit)
    }

    resolveModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
    ): number | undefined {
        if (!providerId || !modelId) return undefined
        return this.modelLimits.get(`${providerId}/${modelId}`)
    }

    /**
     * Best-effort one-time seed from the host's provider catalog
     * (`client.config.providers()` → GET /config/providers). Never throws;
     * returns the number of model-limit entries recorded.
     */
    async hydrateModelLimitsFromClient(client: unknown): Promise<number> {
        try {
            const config = client as { config?: { providers?: () => Promise<{ data?: unknown }> } }
            const result = await config.config?.providers?.()
            const payload = result as { data?: { providers?: unknown } } | undefined
            const providers = payload?.data?.providers
            if (!Array.isArray(providers)) return 0
            let recorded = 0
            for (const provider of providers) {
                const { id, models } = (provider ?? {}) as {
                    id?: unknown
                    models?: Record<string, unknown>
                }
                if (typeof id !== "string" || !models) continue
                for (const [modelId, model] of Object.entries(models)) {
                    const limit = (model as { limit?: { context?: unknown } } | null)?.limit
                    const context = limit?.context
                    if (typeof context === "number" && context > 0) {
                        this.modelLimits.set(`${id}/${modelId}`, context)
                        recorded++
                    }
                }
            }
            return recorded
        } catch {
            return 0
        }
    }

    get(sessionId: string): SessionState | undefined {
        return this.states.get(sessionId)
    }

    all(): SessionState[] {
        return Array.from(this.states.values())
    }

    get size(): number {
        return this.states.size
    }

    // Idempotent: ensureSessionInitialized returns immediately once
    // state.sessionId === sessionId (assigned synchronously before any await),
    // so repeat calls for the same session never re-reset.
    async getOrCreate(
        client: any,
        sessionId: string,
        messages: WithParts[],
        config?: PluginConfig,
    ): Promise<SessionState> {
        let state = this.states.get(sessionId)
        if (!state) {
            state = createSessionState()
            // Assign shared compressionTiming BEFORE ensureSessionInitialized so
            // its init-time applyPendingCompressionDurations reads the shared map.
            state.compressionTiming = this.compressionTiming
            this.states.set(sessionId, state)
            this.enforceSoftCap()
        }
        try {
            await ensureSessionInitialized(
                client,
                state,
                sessionId,
                this.logger,
                messages,
                config,
            )
        } catch (err: any) {
            this.logger.error("Failed to initialize session state", {
                error: err.message,
            })
        }
        return state
    }

    private enforceSoftCap(): void {
        if (this.states.size <= REGISTRY_SOFT_CAP) return
        const oldest = this.states.keys().next().value
        if (oldest !== undefined) {
            this.states.delete(oldest as string)
            this.logger.info("SessionStateRegistry evicted session (soft cap)", {
                sessionId: oldest,
                remaining: this.states.size,
            })
        }
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        compressPermission: undefined,
        prune: {
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            compressBaselineSet: false,
            lastProcessedCompressMessageId: undefined,
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
        qualityGateRetryPending: false,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.compressPermission = undefined
    state.prune = {
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
        lastPerMessageNudgeTurn: 0,
        lastPerMessageNudgeTokens: undefined,
        lastNudgeShownTokens: undefined,
        lastToolOutputNudgeTokens: undefined,
        lastTier2NudgeTokens: undefined,
        lastTier3NudgeTokens: undefined,
        shouldInjectThisTurn: undefined,
        compressBaselineSet: false,
        lastProcessedCompressMessageId: undefined,
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
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
    state.qualityGateRetryPending = false
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    config?: PluginConfig,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        // Fork recovery: no persisted state for this session. If config is
        // available, replay historical compress tool invocations to rebuild
        // pruning state using the current session's message IDs.
        if (config) {
            const rebuilt = rebuildCompressionState(state, messages, config, logger)
            if (rebuilt > 0) {
                await saveSessionState(state, logger)
            }
        }
        return
    }

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
    state.nudges.lastNudgeShownTokens = persisted.nudges.lastNudgeShownTokens
    state.nudges.lastToolOutputNudgeTokens = persisted.nudges.lastToolOutputNudgeTokens
    state.nudges.lastTier2NudgeTokens = persisted.nudges.lastTier2NudgeTokens ?? persisted.nudges.lastTierNudgeTokens
    state.nudges.lastTier3NudgeTokens = persisted.nudges.lastTier3NudgeTokens
    state.nudges.compressBaselineSet = persisted.nudges.compressBaselineSet ?? false
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
