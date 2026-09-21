/**
 * State persistence module for ACP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: $XDG_DATA_HOME/opencode/storage/plugin/acp/{sessionId}.json
 * by default, or the directory configured via `storagePath` (see resolveStorageDir).
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { isAbsolute, join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
    markedForCleanup?: number[]
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
    lastPerMessageNudgeTurn?: number
    lastPerMessageNudgeTokens?: number
    lastNudgeShownTokens?: number
    lastToolOutputNudgeTokens?: number
    lastTier2NudgeTokens?: number
    lastTier3NudgeTokens?: number
    /** @deprecated use lastTier2NudgeTokens — migrated on load */
    lastTierNudgeTokens?: number
    compressBaselineSet?: boolean
}

export interface PersistedMessageIds {
    byRawId: Record<string, string>
    byRef: Record<string, string>
    nextRef: number
}

export interface PersistedSessionState {
    sessionName?: string
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
    messageIds?: PersistedMessageIds
    lastCompaction?: number
    modelContextLimit?: number
    modelProviderID?: string
    modelID?: string
}

/** Default storage directory: $XDG_DATA_HOME/opencode/storage/plugin/acp */
export function getDefaultStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "acp",
    )
}

/**
 * Resolve the configured `storagePath` to an absolute directory.
 * - undefined/empty → default location
 * - `~` or `~/...` → expanded against the home directory
 * - absolute → used as-is
 * - relative → resolved against `projectDir` (opencode's working directory)
 */
export function resolveStorageDir(configured: string | undefined, projectDir: string): string {
    const trimmed = configured?.trim()
    if (!trimmed) {
        return getDefaultStorageDir()
    }
    if (trimmed === "~") {
        return homedir()
    }
    if (trimmed.startsWith("~/")) {
        return join(homedir(), trimmed.slice(2))
    }
    if (isAbsolute(trimmed)) {
        return trimmed
    }
    return join(projectDir, trimmed)
}

function getStorageDir(override?: string): string {
    return override || getDefaultStorageDir()
}

function getSessionFilePath(sessionId: string, storageDir?: string): string {
    return join(getStorageDir(storageDir), `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
    storageDir?: string,
): Promise<void> {
    // Capture file path synchronously before any await — prevents race condition
    // when fire-and-forget saves execute after XDG_DATA_HOME has changed (tests).
    const filePath = getSessionFilePath(sessionId, storageDir)
    const dir = getStorageDir(storageDir)
    if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true })
    }

    const content = JSON.stringify(state, null, 2)
    await fs.writeFile(filePath, content, "utf-8")

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

// [FIX Bug 6] Removed try/catch — errors now propagate to callers so they know save failed
//
// [Issue #384] Ordered, coalescing per-session save queue.
// Long sessions trigger several saves per transform (sync deactivation, batch
// cleanup, nudge anchors, compaction reset, tool finalize). Previously each
// was an independent fire-and-forget whole-file write: overlapping writes
// could complete out of request order (a stale snapshot overwriting a fresh
// one) and bursts produced redundant full-file serializations. Now:
//   - the snapshot is captured at enqueue time (payloads by reference); late
//     serialization at write time only sees strictly-newer values, which is safe
//     because inter-save mutations are additive/monotonic;
//   - a single FIFO writer per session drains snapshots in request order, so
//     on-disk content always reflects the most recent request;
//   - snapshots enqueued before the writer starts are coalesced into ONE
//     write of the latest snapshot — it was serialized after every other in
//     the batch from the same live state, so it is strictly newer;
//   - every caller resolves once its snapshot (or a newer one superseding it)
//     is durable; a failed write rejects that batch's callers (Bug 6 kept).
interface PendingSave {
    sessionId: string
    state: PersistedSessionState
    storageDir?: string
    logger: Logger
}

interface SaveQueue {
    pending: PendingSave[]
    waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>
    draining: boolean
}

const saveQueues = new Map<string, SaveQueue>()

function saveQueueKey(sessionId: string, storageDir?: string): string {
    return `${sessionId}\u0000${storageDir ?? ""}`
}

export function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (!sessionState.sessionId) {
        return Promise.resolve()
    }

    const state: PersistedSessionState = {
        sessionName: sessionName,
        prune: {
            messages: serializePruneMessagesState(sessionState.prune.messages),
        },
        nudges: {
            contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
            turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
            iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            lastPerMessageNudgeTurn: sessionState.nudges.lastPerMessageNudgeTurn ?? 0,
            lastPerMessageNudgeTokens: sessionState.nudges.lastPerMessageNudgeTokens,
            lastNudgeShownTokens: sessionState.nudges.lastNudgeShownTokens,
            lastToolOutputNudgeTokens: sessionState.nudges.lastToolOutputNudgeTokens,
            lastTier2NudgeTokens: sessionState.nudges.lastTier2NudgeTokens,
            lastTier3NudgeTokens: sessionState.nudges.lastTier3NudgeTokens,
            compressBaselineSet: sessionState.nudges.compressBaselineSet,
        },
        stats: sessionState.stats,
        lastUpdated: new Date().toISOString(),
        messageIds: {
            byRawId: Object.fromEntries(sessionState.messageIds.byRawId),
            byRef: Object.fromEntries(sessionState.messageIds.byRef),
            nextRef: sessionState.messageIds.nextRef,
        },
        lastCompaction: sessionState.lastCompaction,
        modelContextLimit: sessionState.modelContextLimit,
        modelProviderID: sessionState.modelProviderID,
        modelID: sessionState.modelID,
    }

    const key = saveQueueKey(sessionState.sessionId, sessionState.storageDir)
    let queue = saveQueues.get(key)
    if (!queue) {
        queue = { pending: [], waiters: [], draining: false }
        saveQueues.set(key, queue)
    }

    const promise = new Promise<void>((resolve, reject) => {
        queue!.waiters.push({ resolve, reject })
    })
    queue.pending.push({
        sessionId: sessionState.sessionId,
        state,
        storageDir: sessionState.storageDir,
        logger,
    })

    // Macrotask boundary: synchronous bursts pile onto one batch before I/O.
    if (!queue.draining) {
        queue.draining = true
        setImmediate(() => drainSaveQueue(key))
    }

    return promise
}

function drainSaveQueue(key: string): void {
    const queue = saveQueues.get(key)
    if (!queue || queue.pending.length === 0) {
        if (queue) {
            queue.draining = false
            if (queue.waiters.length === 0) saveQueues.delete(key)
        }
        return
    }

    // Take the current batch; entries arriving during the write below become
    // the next batch, preserving request order across drains.
    const batch = queue.pending.splice(0, queue.pending.length)
    const waiters = queue.waiters.splice(0, batch.length)
    const latest = batch[batch.length - 1]

    writePersistedSessionState(latest.sessionId, latest.state, latest.logger, latest.storageDir)
        .then(() => {
            for (const waiter of waiters) waiter.resolve()
        })
        .catch((err: unknown) => {
            for (const waiter of waiters) waiter.reject(err)
        })
        .finally(() => {
            const q = saveQueues.get(key)
            if (!q) return
            if (q.pending.length > 0) {
                drainSaveQueue(key)
            } else {
                q.draining = false
                if (q.waiters.length === 0) saveQueues.delete(key)
            }
        })
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
    storageDir?: string,
): Promise<PersistedSessionState | null> {
    const filePath = getSessionFilePath(sessionId, storageDir)

    // [Issue #411] Read is isolated from parsing so errors can be classified
    // (an existsSync pre-check would hide this: it reports false for an
    // UNSEARCHABLE directory too, routing permission loss into "file absent"):
    // - ENOENT → file absent (or raced away): fresh session, silent null.
    // - EISDIR/ENOTDIR → locally corrupted layout: unrecoverable here, warn + null.
    // - anything else (EACCES/EIO/EMFILE/...) → transient I/O failure: must
    //   propagate so session initialization fails loudly and is retried on the
    //   next request. Swallowing these resolved "null" (indistinguishable from
    //   "file absent"), which pinned the session on a fresh empty state for
    //   the process lifetime.
    let content: string
    try {
        content = await fs.readFile(filePath, "utf-8")
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            return null
        }
        if (error?.code === "EISDIR" || error?.code === "ENOTDIR") {
            logger.warn("Invalid session state file location, ignoring", {
                sessionId: sessionId,
                error: error?.message,
            })
            return null
        }
        throw error
    }

    try {
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (!state || !state.prune || !hasPruneMessages || !state.stats || !hasNudgeFormat) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        const persistedMessageIds = (state as any).messageIds as PersistedMessageIds | undefined
        if (persistedMessageIds) {
            ;(state as any)._persistedMessageIds = persistedMessageIds
        }
        const persistedLastCompaction = (state as any).lastCompaction as number | undefined
        if (persistedLastCompaction !== undefined) {
            ;(state as any)._persistedLastCompaction = persistedLastCompaction
        }

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(
    logger: Logger,
    storageDir?: string,
): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        const dir = getStorageDir(storageDir)
        if (!existsSync(dir)) {
            return result
        }

        const files = await fs.readdir(dir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(dir, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    const legacy = (state.prune as { tools?: Record<string, unknown> }).tools
                    result.totalTools += legacy ? Object.keys(legacy).length : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
