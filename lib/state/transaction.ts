import type {
    CompressionBlock,
    MessageIdState,
    Nudges,
    Prune,
    PruneMessagesState,
    SessionState,
    SessionStats,
    ToolParameterEntry,
} from "./types"

/** A side effect that is safe to run only after a working state is committed. */
export type DeferredMutationEffect = () => void | Promise<void>

/**
 * Effects collected while a state mutation is speculative.
 *
 * The transform and tool pipelines can update a working state freely, but
 * persistence and host-facing work must not run until that state has been
 * accepted. Keeping this object deliberately small also makes it usable by
 * the V1 adapter and the V2 patch adapter.
 */
export class DeferredMutationEffects {
    private readonly pending: DeferredMutationEffect[] = []
    private persistenceWasRequested = false

    get persistenceRequested(): boolean {
        return this.persistenceWasRequested
    }

    requestPersistence(): void {
        this.persistenceWasRequested = true
    }

    defer(effect: DeferredMutationEffect): void {
        this.pending.push(effect)
    }

    async run(isActive?: () => boolean): Promise<void> {
        let firstError: unknown
        while (this.pending.length > 0) {
            const effect = this.pending.shift()!
            if (isActive && !isActive()) continue
            try {
                await effect()
            } catch (error) {
                firstError ??= error
            }
        }
        if (firstError !== undefined) {
            throw firstError
        }
    }
}

/**
 * Clone arbitrary runtime values without JSON serialization.
 *
 * Tool parameters are host data and are normally structured-cloneable, but a
 * defensive recursive clone keeps function-bearing test/host values usable by
 * retaining functions by reference instead of failing a transaction.
 */
export function cloneRuntimeValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
    if (value === null || typeof value !== "object") {
        return value
    }

    const existing = seen.get(value)
    if (existing !== undefined) {
        return existing as T
    }

    if (value instanceof Date) {
        return new Date(value.getTime()) as T
    }
    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags) as T
    }
    if (value instanceof ArrayBuffer) {
        const clone = value.slice(0)
        seen.set(value, clone)
        return clone as T
    }
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
        const clone = value.slice(0)
        seen.set(value, clone)
        return clone as T
    }
    if (ArrayBuffer.isView(value)) {
        // Buffer is a Uint8Array subclass whose constructor has legacy
        // overloads; Buffer.from is the only portable way to preserve a real
        // Buffer rather than manufacturing an invalid pseudo-instance.
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
            const clone = Buffer.from(value)
            seen.set(value, clone)
            return clone as T
        }

        const sourceBuffer = value.buffer
        const clonedBuffer = cloneRuntimeValue(sourceBuffer, seen)
        let clone: ArrayBufferView
        if (value instanceof DataView) {
            clone = new DataView(clonedBuffer as ArrayBuffer, value.byteOffset, value.byteLength)
        } else {
            const Constructor = value.constructor as new (
                buffer: ArrayBuffer,
                byteOffset: number,
                length: number,
            ) => ArrayBufferView
            clone = new Constructor(
                clonedBuffer as ArrayBuffer,
                value.byteOffset,
                (value as unknown as { length: number }).length,
            )
        }
        seen.set(value, clone)
        return clone as T
    }
    if (value instanceof Error) {
        // `Object.create(Error.prototype)` passes a shallow prototype check but
        // is not a valid Error value for runtimes inspecting internal slots.
        // Start with a genuine Error, then restore custom subclass prototypes
        // and clone all own (including non-enumerable) fields.
        const clone = new Error(value.message)
        seen.set(value, clone)
        Object.setPrototypeOf(clone, Object.getPrototypeOf(value))
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor) continue
            if ("value" in descriptor) descriptor.value = cloneRuntimeValue(descriptor.value, seen)
            try {
                Object.defineProperty(clone, key, descriptor)
            } catch {
                // Built-in Error fields can be non-configurable on a custom
                // subclass. The genuine Error already carries a valid value.
            }
        }
        return clone as T
    }
    if (value instanceof Map) {
        const clone = new Map<unknown, unknown>()
        seen.set(value, clone)
        for (const [key, entry] of value) {
            clone.set(cloneRuntimeValue(key, seen), cloneRuntimeValue(entry, seen))
        }
        return clone as T
    }
    if (value instanceof Set) {
        const clone = new Set<unknown>()
        seen.set(value, clone)
        for (const entry of value) {
            clone.add(cloneRuntimeValue(entry, seen))
        }
        return clone as T
    }
    if (Array.isArray(value)) {
        const clone: unknown[] = []
        seen.set(value, clone)
        for (const entry of value) {
            clone.push(cloneRuntimeValue(entry, seen))
        }
        return clone as T
    }

    const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
    seen.set(value, clone)
    for (const key of Object.keys(value)) {
        clone[key] = cloneRuntimeValue((value as Record<string, unknown>)[key], seen)
    }
    return clone as T
}

function cloneCompressionBlock(block: CompressionBlock): CompressionBlock {
    return cloneRuntimeValue(block)
}

function clonePruneMessagesState(state: PruneMessagesState): PruneMessagesState {
    const clone: PruneMessagesState = {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(state.activeBlockIds),
        activeByAnchorMessageId: new Map(state.activeByAnchorMessageId),
        nextBlockId: state.nextBlockId,
        nextRunId: state.nextRunId,
        markedForCleanup: new Set(state.markedForCleanup),
        membershipsVerified: state.membershipsVerified,
        structureVersion: state.structureVersion,
        lastSyncedStructureVersion: state.lastSyncedStructureVersion,
        hideConsumedIndex: undefined,
    }

    for (const [messageId, entry] of state.byMessageId) {
        clone.byMessageId.set(messageId, {
            tokenCount: entry.tokenCount,
            allBlockIds: [...entry.allBlockIds],
            activeBlockIds: [...entry.activeBlockIds],
        })
    }
    for (const [blockId, block] of state.blocksById) {
        clone.blocksById.set(blockId, cloneCompressionBlock(block))
    }
    if (state.hideConsumedIndex) {
        clone.hideConsumedIndex = {
            version: state.hideConsumedIndex.version,
            allBlockCallIds: new Set(state.hideConsumedIndex.allBlockCallIds),
            liveRangeKeysByCallId: new Map(
                [...state.hideConsumedIndex.liveRangeKeysByCallId].map(([callId, keys]) => [
                    callId,
                    new Set(keys),
                ]),
            ),
            activeCallIds: new Set(state.hideConsumedIndex.activeCallIds),
        }
    }
    return clone
}

function clonePrune(prune: Prune): Prune {
    return { messages: clonePruneMessagesState(prune.messages) }
}

function cloneNudges(nudges: Nudges): Nudges {
    return {
        contextLimitAnchors: new Set(nudges.contextLimitAnchors),
        turnNudgeAnchors: new Set(nudges.turnNudgeAnchors),
        iterationNudgeAnchors: new Set(nudges.iterationNudgeAnchors),
        lastPerMessageNudgeTurn: nudges.lastPerMessageNudgeTurn,
        lastPerMessageNudgeTokens: nudges.lastPerMessageNudgeTokens,
        lastNudgeShownTokens: nudges.lastNudgeShownTokens,
        lastToolOutputNudgeTokens: nudges.lastToolOutputNudgeTokens,
        lastTier2NudgeTokens: nudges.lastTier2NudgeTokens,
        lastTier3NudgeTokens: nudges.lastTier3NudgeTokens,
        shouldInjectThisTurn: nudges.shouldInjectThisTurn,
        compressBaselineSet: nudges.compressBaselineSet,
        lastProcessedCompressMessageId: nudges.lastProcessedCompressMessageId,
    }
}

function cloneStats(stats: SessionStats): SessionStats {
    return { ...stats }
}

function cloneMessageIds(messageIds: MessageIdState): MessageIdState {
    return {
        byRawId: new Map(messageIds.byRawId),
        byRef: new Map(messageIds.byRef),
        nextRef: messageIds.nextRef,
    }
}

function cloneToolParameters(
    toolParameters: Map<string, ToolParameterEntry>,
): Map<string, ToolParameterEntry> {
    return new Map([...toolParameters].map(([key, entry]) => [key, cloneRuntimeValue(entry)]))
}

/**
 * Clone the complete mutable runtime state.
 *
 * compressionTiming intentionally remains the exact same object. It is owned
 * by SessionStateRegistry and is shared by every session because the event hook
 * has no session ID with which to select a per-session timing map.
 */
export function cloneSessionState(state: SessionState): SessionState {
    const clone: SessionState = {
        sessionId: state.sessionId,
        isSubAgent: state.isSubAgent,
        compressPermission: state.compressPermission,
        prune: clonePrune(state.prune),
        nudges: cloneNudges(state.nudges),
        stats: cloneStats(state.stats),
        compressionTiming: state.compressionTiming,
        toolParameters: cloneToolParameters(state.toolParameters),
        toolIdList: [...state.toolIdList],
        messageIds: cloneMessageIds(state.messageIds),
        lastCompaction: state.lastCompaction,
        currentTurn: state.currentTurn,
        modelContextLimit: state.modelContextLimit,
        modelProviderID: state.modelProviderID,
        modelID: state.modelID,
        systemPromptTokens: state.systemPromptTokens,
        systemPromptTokensSource: state.systemPromptTokensSource,
        storageDir: state.storageDir,
        qualityGateRetryPending: state.qualityGateRetryPending,
        noContextLimitWarned: state.noContextLimitWarned,
    }
    return clone
}

/**
 * Commit a validated working state into a live registry state.
 *
 * The caller must hold the session mutation guard. Every owned mutable field is
 * copied, while compressionTiming is never replaced or rolled back.
 */
export function commitSessionState(target: SessionState, working: SessionState): void {
    if (target.compressionTiming !== working.compressionTiming) {
        throw new Error("Cannot commit a SessionState with a different compressionTiming object")
    }

    const committed = cloneSessionState(working)
    target.sessionId = committed.sessionId
    target.isSubAgent = committed.isSubAgent
    target.compressPermission = committed.compressPermission
    target.prune = committed.prune
    target.nudges = committed.nudges
    target.stats = committed.stats
    target.toolParameters = committed.toolParameters
    target.toolIdList = committed.toolIdList
    target.messageIds = committed.messageIds
    target.lastCompaction = committed.lastCompaction
    target.currentTurn = committed.currentTurn
    target.modelContextLimit = committed.modelContextLimit
    target.modelProviderID = committed.modelProviderID
    target.modelID = committed.modelID
    target.systemPromptTokens = committed.systemPromptTokens
    target.systemPromptTokensSource = committed.systemPromptTokensSource
    target.storageDir = committed.storageDir
    target.qualityGateRetryPending = committed.qualityGateRetryPending
    target.noContextLimitWarned = committed.noContextLimitWarned
}
