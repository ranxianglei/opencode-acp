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
export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (!sessionState.sessionId) {
        return
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

    await writePersistedSessionState(sessionState.sessionId, state, logger, sessionState.storageDir)
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
    storageDir?: string,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId, storageDir)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
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
