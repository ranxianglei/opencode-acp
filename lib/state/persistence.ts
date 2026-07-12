/**
 * State persistence module for ACP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/acp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { cpSync, existsSync as existsSyncSync } from "fs"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

function getLegacyStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
    )
}

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
    compressBaselineSet?: boolean
    postCompressRangesShown?: boolean
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
}

function getStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "acp",
    )
}

/** One-time migration: copy plugin/dcp/ → plugin/acp/ if ACP dir doesn't exist yet */
function migrateFromLegacyIfNeeded(logger: Logger): void {
    const storageDir = getStorageDir()
    const legacyDir = getLegacyStorageDir()
    if (existsSyncSync(storageDir)) return
    if (!existsSyncSync(legacyDir)) return
    try {
        cpSync(legacyDir, storageDir, { recursive: true })
        logger.info(`[ACP] Migrated storage from ${legacyDir} → ${storageDir}`)
    } catch (e: any) {
        logger.warn(`[ACP] Storage migration failed: ${e.message}`)
    }
}

async function ensureStorageDir(logger: Logger): Promise<void> {
    const storageDir = getStorageDir()
    if (!existsSync(storageDir)) {
        migrateFromLegacyIfNeeded(logger)
        await fs.mkdir(storageDir, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(getStorageDir(), `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    // Capture file path synchronously before any await — prevents race condition
    // when fire-and-forget saves execute after XDG_DATA_HOME has changed (tests).
    const filePath = getSessionFilePath(sessionId)
    const storageDir = getStorageDir()
    if (!existsSync(storageDir)) {
        migrateFromLegacyIfNeeded(logger)
        await fs.mkdir(storageDir, { recursive: true })
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
            tools: Object.fromEntries(sessionState.prune.tools),
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
            compressBaselineSet: sessionState.nudges.compressBaselineSet,
            postCompressRangesShown: sessionState.nudges.postCompressRangesShown,
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
    }

    await writePersistedSessionState(sessionState.sessionId, state, logger)
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
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

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        const storageDir = getStorageDir()
        if (!existsSync(storageDir)) {
            return result
        }

        const files = await fs.readdir(storageDir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(storageDir, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
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
