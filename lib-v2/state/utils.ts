import type {
    CompressionBlock,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isMessageWithInfo } from "../messages/shape"
import { createPruneMessagesState } from "./factory"

export { createPruneMessagesState, createSessionState } from "./factory"
export { isMessageCompacted } from "./queries"

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block || !block.active) {
            continue
        }
        total += block.summaryTokens
    }
    return total
}

export function countTurns(messages: WithParts[]): number {
    let count = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) continue
        if (msg.info.role === "user") count++
    }
    return count
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    let latest = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) continue
        if (msg.info.summary === true) {
            const created = msg.info.time?.created ?? 0
            if (created > latest) latest = created
        }
    }
    return latest
}

export function serializePruneMessagesState(state: PruneMessagesState): Record<string, unknown> {
    return {
        byMessageId: Object.fromEntries(state.byMessageId),
        blocksById: Object.fromEntries(state.blocksById),
        activeBlockIds: [...state.activeBlockIds],
        activeByAnchorMessageId: Object.fromEntries(state.activeByAnchorMessageId),
        nextBlockId: state.nextBlockId,
        nextRunId: state.nextRunId,
        markedForCleanup: [...state.markedForCleanup],
    }
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    if (!obj || typeof obj !== "object") return new Map()
    const entries = Object.entries(obj).filter(
        (entry): entry is [string, number] =>
            typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    return new Map(entries)
}

export function loadPruneMessagesState(persisted?: Record<string, unknown>): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!persisted || typeof persisted !== "object") return state

    const p = persisted as {
        nextBlockId?: number
        nextRunId?: number
        byMessageId?: Record<string, any>
        blocksById?: Record<string, any>
        activeBlockIds?: number[]
        activeByAnchorMessageId?: Record<string, number>
        markedForCleanup?: number[]
    }

    if (typeof p.nextBlockId === "number" && Number.isInteger(p.nextBlockId)) {
        state.nextBlockId = Math.max(1, p.nextBlockId)
    }
    if (typeof p.nextRunId === "number" && Number.isInteger(p.nextRunId)) {
        state.nextRunId = Math.max(1, p.nextRunId)
    }

    if (p.activeBlockIds && Array.isArray(p.activeBlockIds)) {
        for (const id of p.activeBlockIds) {
            if (typeof id === "number") state.activeBlockIds.add(id)
        }
    }

    if (p.activeByAnchorMessageId && typeof p.activeByAnchorMessageId === "object") {
        for (const [k, v] of Object.entries(p.activeByAnchorMessageId)) {
            if (typeof v === "number") state.activeByAnchorMessageId.set(k, v)
        }
    }

    if (p.markedForCleanup && Array.isArray(p.markedForCleanup)) {
        for (const id of p.markedForCleanup) {
            if (typeof id === "number") state.markedForCleanup.add(id)
        }
    }

    if (p.byMessageId && typeof p.byMessageId === "object") {
        for (const [msgId, entry] of Object.entries(p.byMessageId)) {
            if (!entry || typeof entry !== "object") continue
            const e = entry as { tokenCount?: number; allBlockIds?: number[]; activeBlockIds?: number[] }
            state.byMessageId.set(msgId, {
                tokenCount: typeof e.tokenCount === "number" ? e.tokenCount : 0,
                allBlockIds: Array.isArray(e.allBlockIds) ? e.allBlockIds.filter((x) => typeof x === "number") : [],
                activeBlockIds: Array.isArray(e.activeBlockIds) ? e.activeBlockIds.filter((x) => typeof x === "number") : [],
            })
        }
    }

    if (p.blocksById && typeof p.blocksById === "object") {
        for (const [idStr, block] of Object.entries(p.blocksById)) {
            const id = parseInt(idStr, 10)
            if (isNaN(id) || id <= 0) continue
            if (!block || typeof block !== "object") continue
            const b = block as CompressionBlock & { active?: boolean }
            state.blocksById.set(id, b as CompressionBlock)
            if (b.active === true) {
                state.activeBlockIds.add(id)
                if (b.anchorMessageId && !state.activeByAnchorMessageId.has(b.anchorMessageId)) {
                    state.activeByAnchorMessageId.set(b.anchorMessageId, id)
                }
            }
        }
    }

    return state
}
