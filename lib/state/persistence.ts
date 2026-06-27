import { promises as fs } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Logger } from "../infra/logger"
import type {
    SessionState,
    CompressionBlock,
    PrunedMessageEntry,
    PruneMessagesState,
} from "./types"

function getStorageBase(): string {
    const xdgData = process.env.XDG_DATA_HOME
    const root = xdgData && xdgData.length > 0 ? xdgData : join(homedir(), ".local", "share")
    return join(root, "opencode", "storage", "plugin", "acp")
}

function getDcpStorageBase(): string {
    const xdgData = process.env.XDG_DATA_HOME
    const root = xdgData && xdgData.length > 0 ? xdgData : join(homedir(), ".local", "share")
    return join(root, "opencode", "storage", "plugin", "dcp")
}

const STORAGE_BASE = getStorageBase()
const DCP_STORAGE_BASE = getDcpStorageBase()

interface PersistedPrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

interface PersistedCompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: string
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    survivedCount: number
    generation?: string
}

interface PersistedPruneMessagesState {
    byMessageId?: Record<string, PersistedPrunedMessageEntry>
    blocksById?: Record<string, PersistedCompressionBlock>
    activeBlockIds?: number[]
    activeByAnchorMessageId?: Record<string, number>
    nextBlockId?: number
    nextRunId?: number
    markedForCleanup?: number[]
}

interface PersistedNudges {
    contextLimitAnchors?: string[]
    turnAnchors?: string[]
    iterationAnchors?: string[]
    lastNudgeTurn?: number
}

interface PersistedMessageIdMapping {
    byRawId?: Record<string, string>
    byRef?: Record<string, string>
    nextRef?: number
    nextRefIndex?: number
}

interface PersistedSessionState {
    sessionId: string | null
    modelContextLimit?: number
    isSubAgent?: boolean
    lastCompaction: number
    currentTurn: number
    prune: {
        tools?: Record<string, number>
        messages?: PersistedPruneMessagesState
    }
    nudges: PersistedNudges
    stats: { pruneTokenCounter: number; totalPruneTokens: number }
    messageIds: PersistedMessageIdMapping
    compressionTiming?: unknown
    toolParameters?: unknown[]
    manualMode?: unknown
    pendingManualTrigger?: unknown
}

function getStoragePath(sessionId: string): string {
    return join(STORAGE_BASE, `${sessionId}.json`)
}

export async function ensureStorageDir(): Promise<void> {
    await fs.mkdir(STORAGE_BASE, { recursive: true })
}

export async function saveSessionState(
    state: SessionState,
    logger: Logger,
): Promise<void> {
    if (!state.sessionId) {
        return
    }

    const filePath = getStoragePath(state.sessionId)
    const data = serializeState(state)

    try {
        await ensureStorageDir()
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
        logger.info("Saved session state to disk", { sessionId: state.sessionId })
    } catch (err) {
        logger.warn("Failed to save session state", { error: String(err) })
    }
}

export function serializeState(state: SessionState): PersistedSessionState {
    return {
        sessionId: state.sessionId,
        modelContextLimit: state.modelContextLimit,
        isSubAgent: state.isSubAgent,
        lastCompaction: state.lastCompaction,
        currentTurn: state.currentTurn,
        prune: {
            tools: Object.fromEntries(state.prune.tools),
            messages: {
                byMessageId: Object.fromEntries(state.prune.messages.byMessageId),
                blocksById: Object.fromEntries(state.prune.messages.blocksById),
                activeBlockIds: [...state.prune.messages.activeBlockIds],
                activeByAnchorMessageId: Object.fromEntries(state.prune.messages.activeByAnchorMessageId),
                nextBlockId: state.prune.messages.nextBlockId,
                nextRunId: state.prune.messages.nextRunId,
                markedForCleanup: [...state.prune.messages.markedForCleanup],
            },
        },
        nudges: {
            contextLimitAnchors: [...state.nudges.contextLimitAnchors],
            turnAnchors: [...state.nudges.turnAnchors],
            iterationAnchors: [...state.nudges.iterationAnchors],
            lastNudgeTurn: state.nudges.lastNudgeTurn,
        },
        stats: state.stats,
        messageIds: {
            byRawId: Object.fromEntries(state.messageIds.byRawId),
            byRef: Object.fromEntries(state.messageIds.byRef),
            nextRef: state.messageIds.nextRef,
        },
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    if (!sessionId) {
        return null
    }

    const filePath = getStoragePath(sessionId)

    try {
        const raw = await fs.readFile(filePath, "utf-8")
        const parsed = JSON.parse(raw) as PersistedSessionState
        const normalized = normalizePersistedState(parsed)
        if (normalized === null) {
            logger.warn("Loaded session state is missing required fields", { sessionId })
            return null
        }
        logger.info("Loaded session state from disk", { sessionId })
        return normalized
    } catch {
        return null
    }
}

function normalizePersistedState(
    parsed: unknown,
): PersistedSessionState | null {
    if (!parsed || typeof parsed !== "object") {
        return null
    }

    const obj = parsed as Partial<PersistedSessionState>
    if (!obj.prune || !obj.stats) {
        return null
    }

    if (obj.nudges) {
        obj.nudges.contextLimitAnchors = dedupeStringArray(obj.nudges.contextLimitAnchors)
        obj.nudges.turnAnchors = dedupeStringArray(obj.nudges.turnAnchors)
        obj.nudges.iterationAnchors = dedupeStringArray(obj.nudges.iterationAnchors)
    }

    return obj as PersistedSessionState
}

function dedupeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of value) {
        if (typeof entry !== "string" || entry.length === 0) continue
        if (seen.has(entry)) continue
        seen.add(entry)
        out.push(entry)
    }
    return out
}

export async function deleteSessionState(sessionId: string, logger: Logger): Promise<void> {
    if (!sessionId) return
    const filePath = getStoragePath(sessionId)
    try {
        await fs.unlink(filePath)
        logger.info("Deleted session state", { sessionId })
    } catch {
        // File doesn't exist — fine
    }
}
