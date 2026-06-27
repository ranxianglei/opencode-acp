import type { SessionState, PruneMessagesState } from "./types"

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
        markedForCleanup: new Set(),
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        modelContextLimit: undefined,
        isSubAgent: false,
        lastCompaction: 0,
        currentTurn: 0,

        prune: {
            tools: new Map(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnAnchors: new Set(),
            iterationAnchors: new Set(),
            lastNudgeTurn: 0,
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRefIndex: 1,
        },
        compressionTiming: {
            startsByCallId: new Map(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map(),
        manualMode: false,
        pendingManualTrigger: null,
    }
}
