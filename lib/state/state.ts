import { existsSync } from "fs"
import { join } from "path"
import { cwd } from "process"
import type { ModelInventory, SessionService } from "../host"
import { resolveModelInventory, resolveSessionService } from "../host/legacy"
import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import {
    applyPendingCompressionDurations,
    type CompressionTimingState,
    type PendingCompressionDuration,
} from "../compress/timing"
import {
    getDefaultStorageDir,
    loadSessionState,
    resolveStorageDir,
    saveSessionState,
    normalizePersistedMessageIds,
} from "./persistence"
import { commitSessionState, cloneSessionState, type DeferredMutationEffects } from "./transaction"
import { createModelLimitCatalog } from "./model-limits"
import { rebuildCompressionState, restoreForkCompressionState } from "./rebuild"
import {
    getSessionParentId,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    collectTurnNudgeAnchors,
} from "./utils"
import { parseMessageRef, formatMessageRef } from "../message-ids"
import { isAcpSyntheticId } from "../synthetic-ids"

/**
 * Per-turn state update (compaction detection + turn count). Extracted from the
 * old `checkSession`; session-switch + init now live in SessionStateRegistry.
 */
export async function updatePerTurnState(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    effects?: DeferredMutationEffects,
): Promise<void> {
    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        effects?.requestPersistence()
    }

    state.currentTurn = countTurns(state, messages)
}

// Soft cap on held sessions — guards a long-lived plugin process (daemon mode)
// from unbounded growth. Evicted sessions reload from persisted JSON on next
// access; modelContextLimit and all persisted fields survive eviction.
const REGISTRY_SOFT_CAP = 32

interface DeferredValue<T> {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
}

function createDeferred<T>(): DeferredValue<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

type SessionHistoryLoader<History> = () => History | Promise<History>
type SessionHistoryMessages<History> = (history: History) => WithParts[] | undefined
type SessionMutation<History, Result> = (
    state: SessionState,
    history: History,
) => Result | Promise<Result>

export interface SessionMutationOptions<Result = unknown> {
    /** Stage initialization persistence until the caller authorizes commit. */
    effects?: DeferredMutationEffects
    /** Invalidate initialization and restore its pre-operation state on unload. */
    isActive?: () => boolean
    /** Tell the registry whether the guarded operation committed its outcome. */
    commitResult?: (result: Result) => boolean
    /** Apply the accepted state/event result synchronously before any await. */
    commit?: (state: SessionState, result: Result) => void
    /** Flush persistence/effects while the same session reservation is held. */
    postCommit?: (state: SessionState, result: Result) => Promise<void> | void
}

interface PendingTimingSnapshot {
    entry: PendingCompressionDuration
    snapshot: PendingCompressionDuration
}

interface InitializationSnapshot {
    state: SessionState
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingTimingSnapshot>
}

function snapshotInitialization(state: SessionState): InitializationSnapshot {
    return {
        state: cloneSessionState(state),
        startsByCallId: new Map(state.compressionTiming.startsByCallId),
        pendingByCallId: new Map(
            [...state.compressionTiming.pendingByCallId].map(([key, entry]) => [
                key,
                { entry, snapshot: { ...entry } },
            ]),
        ),
    }
}

function restoreInitialization(state: SessionState, snapshot: InitializationSnapshot): void {
    commitSessionState(state, snapshot.state)

    const pending = state.compressionTiming.pendingByCallId
    pending.clear()
    for (const [key, value] of snapshot.pendingByCallId) {
        Object.assign(value.entry, value.snapshot)
        pending.set(key, value.entry)
    }

    const starts = state.compressionTiming.startsByCallId
    starts.clear()
    for (const [key, startedAt] of snapshot.startsByCallId) {
        starts.set(key, startedAt)
    }
}

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
    private readonly initializations = new Map<string, Promise<SessionState>>()
    private readonly mutationTails = new Map<string, Promise<void>>()
    /** Includes queued work, not just the callback currently executing. */
    private readonly guardedWork = new Map<string, number>()
    /** Work whose callback is currently executing and may mutate live state. */
    private readonly activeWork = new Map<string, number>()
    readonly compressionTiming: CompressionTimingState = {
        startsByCallId: new Map<string, number>(),
        pendingByCallId: new Map<string, PendingCompressionDuration>(),
    }

    // [FIX #312] Model-limit catalog (full rationale in ./model-limits.ts):
    // lets the messages hook reconcile state.modelContextLimit against the
    // model named on the request's user message instead of waiting one turn
    // for the system hook. Shared implementation — the test registry stub
    // composes the same factory.
    private readonly catalog = createModelLimitCatalog()

    constructor(
        private readonly logger: Logger,
        private readonly projectDir?: string,
    ) {}

    recordModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void {
        this.catalog.record(providerId, modelId, limit)
    }

    resolveModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
    ): number | undefined {
        return this.catalog.resolve(providerId, modelId)
    }

    /** Best-effort one-time seed from a host-neutral model inventory. */
    hydrateModelLimits(inventory: ModelInventory): Promise<number> {
        return this.catalog.hydrate(inventory)
    }

    /** @deprecated Use hydrateModelLimits() with a host model inventory. */
    hydrateModelLimitsFromClient(client: unknown): Promise<number> {
        return this.catalog.hydrateFromClient(client)
    }

    // [FIX #346] The init-time seed (above) is fire-and-forget and races
    // server readiness: in headless spawn+resume mode the provider-config
    // call can fail before the server is up, leaving the catalog empty for
    // the process's lifetime. During a request the server is guaranteed up
    // (we are inside its pipeline), so on a catalog miss we retry hydration
    // once per process before giving up (the fallback limit then applies).
    // The in-flight promise (not a boolean) lets concurrent callers await the
    // same hydration instead of skipping it.
    private lazyHydration: Promise<number> | undefined

    async hydrateAndResolve(
        inventory: ModelInventory,
        providerId: string,
        modelId: string,
    ): Promise<number | undefined> {
        const existing = this.catalog.resolve(providerId, modelId)
        if (existing !== undefined) {
            return existing
        }
        this.lazyHydration ??= this.catalog.hydrate(resolveModelInventory(inventory))
        await this.lazyHydration
        return this.catalog.resolve(providerId, modelId)
    }

    get(sessionId: string): SessionState | undefined {
        // A state object is inserted before async initialization can begin, but
        // it is deliberately invisible until initialization and its guarded
        // operation have both completed successfully.
        // Existing sessions are likewise hidden while a live-state callback is
        // executing.  Legacy system/event callers use get/all outside the
        // reservation and therefore fail closed instead of observing a partial
        // mutation.
        if (this.initializations.has(sessionId) || this.activeWork.has(sessionId)) return undefined
        return this.states.get(sessionId)
    }

    all(): SessionState[] {
        return Array.from(this.states.keys())
            .map((sessionId) => this.get(sessionId))
            .filter((state): state is SessionState => state !== undefined)
    }

    get size(): number {
        return this.states.size
    }

    // Idempotent: ensureSessionInitialized returns immediately once
    // state.sessionId === sessionId (assigned synchronously before any await),
    // so repeat calls for the same session never re-reset.
    async getOrCreate(
        sessions: SessionService,
        sessionId: string,
        messages: WithParts[],
        config?: PluginConfig,
    ): Promise<SessionState> {
        const state = await this.withSessionMutationAndInitialize(
            sessions,
            sessionId,
            () => messages,
            (history) => history,
            config,
            async (state) => state,
        )
        if (!state) throw new Error(`ACP: session ${sessionId} has no initialized state`)
        return state
    }

    /**
     * Reserve a session before loading history, then initialize and mutate it
     * while the same reservation is held. New sessions remain behind their
     * initialization barrier until the operation reports an accepted result.
     * This is the atomic entry point for adapters whose history must be read as
     * part of the transaction (notably the V2 context hook).
     *
     * `historyToMessages` may return undefined to reject/skip a history
     * projection without creating a new persisted session state.
     */
    async withSessionMutationAndInitialize<History, Result>(
        sessions: SessionService,
        sessionId: string,
        loadHistory: SessionHistoryLoader<History>,
        historyToMessages: SessionHistoryMessages<History>,
        config: PluginConfig | undefined,
        operation: SessionMutation<History, Result>,
        options?: SessionMutationOptions<Result>,
    ): Promise<Result | undefined> {
        return this.withReservedSessionWork(sessionId, async () => {
            let state = this.states.get(sessionId)
            let initialization = this.initializations.get(sessionId)
            let createdInitialization: DeferredValue<SessionState> | undefined
            // Snapshot every guarded operation, not only fresh initialization.
            // Some legacy callers mutate the live state directly and a
            // synchronous external commit can still throw after doing part of
            // that work.  Restoring this snapshot keeps both existing and
            // fresh sessions (including shared timing maps) transaction-safe.
            let operationSnapshot: InitializationSnapshot | undefined
            let initializationFinished = false
            let commitAccepted = false

            if (!state) {
                state = createSessionState()
                // Assign shared compressionTiming before any initialization
                // await so init-time pending durations use the shared map.
                state.compressionTiming = this.compressionTiming
                this.states.set(sessionId, state)
                createdInitialization = this.beginInitialization(sessionId)
                initialization = createdInitialization.promise
            } else if (!initialization && state.sessionId !== sessionId) {
                // A few lightweight test registries seed a raw state directly.
                // Bring that state through the same visible initialization
                // barrier instead of exposing it during an await.
                state.compressionTiming = this.compressionTiming
                createdInitialization = this.beginInitialization(sessionId)
                initialization = createdInitialization.promise
            }

            operationSnapshot = snapshotInitialization(state)

            const finishCreatedInitialization = (): void => {
                if (!createdInitialization || initializationFinished) return
                initializationFinished = true
                createdInitialization.resolve(state!)
                this.finishInitialization(sessionId, initialization!)
            }

            try {
                // The reservation was installed synchronously before this
                // history load. A concurrent caller can queue, but cannot read
                // or commit a stale snapshot for this session.
                const history = await loadHistory()
                const messages = historyToMessages(history)
                if (messages === undefined) {
                    if (createdInitialization && state.sessionId !== sessionId) {
                        this.discardInitialization(sessionId, createdInitialization)
                    }
                    return undefined
                }

                if (initialization && state.sessionId !== sessionId) {
                    if (options?.isActive && !options.isActive()) {
                        if (operationSnapshot) restoreInitialization(state, operationSnapshot)
                        this.discardInitialization(sessionId, createdInitialization)
                        return undefined
                    }
                    try {
                        await ensureSessionInitialized(
                            resolveSessionService(sessions),
                            state,
                            sessionId,
                            this.logger,
                            messages,
                            config,
                            this.projectDir,
                            options?.effects,
                        )
                        if (options?.isActive && !options.isActive()) {
                            if (operationSnapshot) restoreInitialization(state, operationSnapshot)
                            this.discardInitialization(sessionId, createdInitialization)
                            return undefined
                        }
                    } catch (error) {
                        if (operationSnapshot) restoreInitialization(state, operationSnapshot)
                        createdInitialization?.reject(error)
                        throw error
                    }
                } else if (initialization) {
                    // If another compatible initializer was already queued,
                    // wait for its complete state rather than observing its
                    // synchronously inserted placeholder.
                    await initialization
                }

                if (state.sessionId !== sessionId) {
                    throw new Error(`ACP: session ${sessionId} is not initialized`)
                }
                const result = await operation(state, history)
                const committed =
                    (options?.commitResult ? options.commitResult(result) : true) &&
                    (options?.isActive ? options.isActive() : true)
                if (!committed) {
                    if (operationSnapshot) restoreInitialization(state, operationSnapshot)
                    this.discardInitialization(sessionId, createdInitialization)
                    return result
                }

                // Once the synchronous commit returns, the state and external
                // result have been accepted.  A later effect/post-commit error
                // must not roll that decision back (and must not strand a
                // fresh initialization barrier).
                try {
                    if (options?.commit) options.commit(state, result)
                    commitAccepted = true
                    if (options?.postCommit) await options.postCommit(state, result)
                } catch (error) {
                    if (commitAccepted) finishCreatedInitialization()
                    throw error
                }

                finishCreatedInitialization()
                return result
            } catch (error) {
                // A failed operation or synchronous commit has not been
                // accepted. Restore the complete live snapshot before removing
                // a fresh placeholder.  If postCommit threw, its barrier was
                // finalized above and the accepted state must remain visible.
                if (!commitAccepted && this.states.get(sessionId) === state) {
                    if (operationSnapshot) restoreInitialization(state, operationSnapshot)
                }
                if (
                    !commitAccepted &&
                    createdInitialization &&
                    this.states.get(sessionId) === state
                ) {
                    this.discardInitialization(sessionId, createdInitialization)
                }
                throw error
            }
        })
    }

    /**
     * Serialize all state-sensitive work for one session. Different sessions
     * use independent tails and therefore remain concurrent.
     */
    async withSessionMutation<T>(
        sessionId: string,
        operation: (state: SessionState) => Promise<T> | T,
    ): Promise<T> {
        return this.withReservedSessionWork(sessionId, async () => {
            const initialization = this.initializations.get(sessionId)
            if (initialization) await initialization
            const state = this.states.get(sessionId)
            if (!state || this.initializations.has(sessionId)) {
                throw new Error(`ACP: session ${sessionId} has no initialized state`)
            }
            return await operation(state)
        })
    }

    /** Install a reservation synchronously, before the first awaited operation. */
    private withReservedSessionWork<T>(
        sessionId: string,
        operation: () => Promise<T> | T,
    ): Promise<T> {
        const previous = this.mutationTails.get(sessionId) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>((resolve) => {
            release = resolve
        })
        this.mutationTails.set(sessionId, current)
        // Count queued work immediately. Soft-cap eviction must not remove a
        // state while its initialization/history/operation is merely queued.
        this.guardedWork.set(sessionId, (this.guardedWork.get(sessionId) ?? 0) + 1)
        this.enforceSoftCap()

        return (async () => {
            try {
                await previous
                this.activeWork.set(sessionId, (this.activeWork.get(sessionId) ?? 0) + 1)
                return await operation()
            } finally {
                const activeCount = (this.activeWork.get(sessionId) ?? 1) - 1
                if (activeCount > 0) this.activeWork.set(sessionId, activeCount)
                else this.activeWork.delete(sessionId)
                const count = (this.guardedWork.get(sessionId) ?? 1) - 1
                if (count > 0) this.guardedWork.set(sessionId, count)
                else this.guardedWork.delete(sessionId)
                release()
                if (this.mutationTails.get(sessionId) === current) {
                    this.mutationTails.delete(sessionId)
                }
                this.enforceSoftCap()
            }
        })()
    }

    private beginInitialization(sessionId: string): DeferredValue<SessionState> {
        const initialization = createDeferred<SessionState>()
        this.initializations.set(sessionId, initialization.promise)
        // A failed initialization is also observed by callers that only see
        // the registry barrier, preventing an unhandled rejection.
        void initialization.promise.catch(() => {})
        this.enforceSoftCap()
        return initialization
    }

    private discardInitialization(
        sessionId: string,
        initialization: DeferredValue<SessionState> | undefined,
    ): void {
        if (initialization) initialization.reject(new Error("ACP session initialization cancelled"))
        if (initialization && this.initializations.get(sessionId) === initialization.promise) {
            this.initializations.delete(sessionId)
            this.states.delete(sessionId)
        }
    }

    private finishInitialization(sessionId: string, initialization: Promise<SessionState>): void {
        if (this.initializations.get(sessionId) === initialization) {
            this.initializations.delete(sessionId)
        }
        // Do not evict here: the getOrCreate caller is about to receive this
        // state, and no guarded-work reservation exists until it enters the
        // mutation queue. Subsequent insertions/guard releases enforce the cap.
    }

    private enforceSoftCap(): void {
        while (this.states.size > REGISTRY_SOFT_CAP) {
            let oldest: string | undefined
            for (const sessionId of this.states.keys()) {
                if (!this.initializations.has(sessionId) && !this.guardedWork.has(sessionId)) {
                    oldest = sessionId
                    break
                }
            }
            if (oldest === undefined) return
            this.states.delete(oldest)
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
        modelProviderID: undefined,
        modelID: undefined,
        systemPromptTokens: undefined,
        systemPromptTokensSource: undefined,
        storageDir: undefined,
        qualityGateRetryPending: false,
        noContextLimitWarned: false,
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
    state.modelProviderID = undefined
    state.modelID = undefined
    state.systemPromptTokens = undefined
    state.storageDir = undefined
    state.qualityGateRetryPending = false
    state.noContextLimitWarned = false
}

export async function ensureSessionInitialized(
    sessions: SessionService,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    config?: PluginConfig,
    projectDir?: string,
    effects?: DeferredMutationEffects,
): Promise<void> {
    const sessionService = resolveSessionService(sessions)
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.sessionId = sessionId
    // Resolve the configured storage location once per session (transient).
    // Relative paths resolve against projectDir (opencode's directory),
    // falling back to process.cwd() when the caller has no directory context.
    state.storageDir = config?.storagePath
        ? resolveStorageDir(config.storagePath, projectDir ?? cwd())
        : undefined

    const parentSessionId = await getSessionParentId(sessionService, sessionId)
    const isChildSession = parentSessionId !== undefined
    state.isSubAgent = isChildSession

    const currentCompactionTimestamp = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const loadedPersisted = await loadSessionState(sessionId, logger, state.storageDir)
    // Normalize legacy four-digit refs before loading prune blocks.  Boundary
    // IDs live on CompressionBlock as well as in the bidirectional ref maps;
    // doing this only in fork recovery leaves ordinary restarts with blocks
    // that still point at stale m0001/m0002 boundaries.
    const persisted =
        loadedPersisted === null ? null : normalizePersistedMessageIds(loadedPersisted)
    if (persisted === null) {
        // No persisted boundary exists on this branch, so the current history
        // boundary is safe to carry into fork/replay persistence.
        state.lastCompaction = currentCompactionTimestamp
        state.currentTurn = countTurns(state, messages)
        // Fork recovery: a fork gets new raw IDs and may omit historical
        // compress inputs. Prefer translating the parent state; replay remains
        // the cross-machine and legacy fallback.
        // The parent state transfer below is preferred for forks; replay remains
        // the cross-machine and legacy fallback.
        // storagePath points elsewhere but the session file still sits at the
        // default location (e.g. the user just configured storagePath). No
        // auto-migration — warn once (this init path runs once per session).
        const defaultPath = join(getDefaultStorageDir(), `${sessionId}.json`)
        if (state.storageDir && existsSync(defaultPath)) {
            logger.warn(
                "storagePath is set but no valid state was found there; a state file exists at the default location — move it manually to keep history",
                { sessionId, storageDir: state.storageDir, defaultPath },
            )
        }
        // Fork recovery: no persisted state for this session. If config is
        // available, replay historical compress tool invocations to rebuild
        // pruning state using the current session's message IDs.
        if (config) {
            let restored = 0
            if (parentSessionId) {
                try {
                    const parentState = await loadSessionState(
                        parentSessionId,
                        logger,
                        state.storageDir,
                    )
                    const parent = parentState ? normalizePersistedMessageIds(parentState) : null
                    const parentMessages = parent
                        ? await sessionService.parentMessages(parentSessionId)
                        : []
                    if (parent && parentMessages.length > 0) {
                        // Standard subagents skip their first user prompt when
                        // assigning refs. A copied fork needs that prompt to
                        // match the parent state, but only for this transfer.
                        state.isSubAgent = false
                        try {
                            restored = restoreForkCompressionState(
                                state,
                                messages,
                                parent,
                                parentMessages,
                                logger,
                            )
                        } finally {
                            state.isSubAgent = isChildSession
                        }
                    }
                } catch (error: any) {
                    logger.warn("fork: parent state transfer unavailable, replaying history", {
                        parentSessionId,
                        error: error?.message,
                    })
                }
            }

            const rebuilt =
                restored > 0 ? 0 : rebuildCompressionState(state, messages, config, logger)
            if (restored > 0 || rebuilt > 0) {
                if (effects) effects.requestPersistence()
                else await saveSessionState(state, logger)
            }
        }
        state.isSubAgent = isChildSession
        return
    }

    state.isSubAgent = isChildSession
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
    state.nudges.lastTier2NudgeTokens =
        persisted.nudges.lastTier2NudgeTokens ?? persisted.nudges.lastTierNudgeTokens
    state.nudges.lastTier3NudgeTokens = persisted.nudges.lastTier3NudgeTokens
    state.nudges.compressBaselineSet = persisted.nudges.compressBaselineSet ?? false
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const persistedAny = persisted as any
    const persistedMessageIds = persisted.messageIds ?? persistedAny._persistedMessageIds
    if (persistedMessageIds) {
        state.messageIds = {
            byRawId: new Map(Object.entries(persistedMessageIds.byRawId || {})),
            byRef: new Map(Object.entries(persistedMessageIds.byRef || {})),
            nextRef: persistedMessageIds.nextRef || 1,
        }
        // [FIX Bug 29] Auto-cleanup stale synthetic message refs from persistence.
        // This includes ACP-owned V2 command notices, which otherwise consume
        // aliases on every repeated command until the finite ref namespace is
        // exhausted. Check both directions because older snapshots may contain
        // only one side of a partially written mapping.
        let removedSyntheticRef = false
        for (const [rawId, ref] of state.messageIds.byRawId) {
            if (isAcpSyntheticId(rawId)) {
                removedSyntheticRef = true
                state.messageIds.byRawId.delete(rawId)
                state.messageIds.byRef.delete(ref)
            }
        }
        for (const [ref, rawId] of state.messageIds.byRef) {
            if (isAcpSyntheticId(rawId)) {
                removedSyntheticRef = true
                state.messageIds.byRef.delete(ref)
                state.messageIds.byRawId.delete(rawId)
            }
        }
        if (removedSyntheticRef) {
            let candidate = 1
            while (candidate <= 99999 && state.messageIds.byRef.has(formatMessageRef(candidate))) {
                candidate++
            }
            state.messageIds.nextRef = candidate
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
    const persistedCompaction =
        typeof (persisted.lastCompaction ?? persistedAny._persistedLastCompaction) === "number" &&
        Number.isFinite(persisted.lastCompaction ?? persistedAny._persistedLastCompaction)
            ? (persisted.lastCompaction ?? persistedAny._persistedLastCompaction)
            : 0
    if (currentCompactionTimestamp > persistedCompaction) {
        // Compare only after loading the persisted transient state. Assigning
        // the current boundary before this point makes a restart immediately
        // after native compaction look already reconciled and preserves stale
        // refs/nudges/tool caches.
        resetOnCompaction(state)
        state.lastCompaction = currentCompactionTimestamp
        state.currentTurn = countTurns(state, messages)
    } else {
        state.lastCompaction = Math.max(currentCompactionTimestamp, persistedCompaction)
        state.currentTurn = countTurns(state, messages)
    }
    if (typeof persisted.modelContextLimit === "number" && persisted.modelContextLimit > 0) {
        state.modelContextLimit = persisted.modelContextLimit
        // Restore the identity pair together with the limit (persisted as a
        // pair in saveSessionState) so the messages-hook staleness check
        // survives restarts. Invalid/absent limit → fresh undefined pair.
        state.modelProviderID = persisted.modelProviderID
        state.modelID = persisted.modelID
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        if (effects) effects.requestPersistence()
        else await saveSessionState(state, logger)
    }
    // [FIX Bug 1] Always save after initialization to persist messageIds + lastCompaction
    if (effects) effects.requestPersistence()
    else await saveSessionState(state, logger)
}
