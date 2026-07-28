/**
 * Regression tests for tier detection fix.
 *
 * Bug: `applyCompressionState` determined tier from `consumedBlockIds` — if
 * any consumed block existed, tier went up. This misclassified T1 compressions
 * that incidentally overlapped existing T1 blocks as T2.
 *
 * Fix: Tier is determined by boundary KIND (selection.startReference.kind /
 * selection.endReference.kind). Message boundaries → T1. Block boundaries →
 * T2+ (max consumed tier + 1).
 */

import assert from "node:assert/strict"
import test from "node:test"
import { applyCompressionState, wrapCompressedSummary } from "../lib/compress/state"
import type { CompressionStateInput, SelectionResolution, BoundaryReference } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"

const SID = "session-tier-fix"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 200,
        durationMs: 0,
        tier: 1,
        topic: "test",
        batchTopic: "test",
        startId: "m00001",
        endId: "m00005",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: "call-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "[Compressed conversation section]\nOld block summary.",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeState(): SessionState {
    return {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        pendingManualTrigger: null,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map<string, PrunedMessageEntry>(),
                blocksById: new Map(),
                activeBlockIds: new Set<number>(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 10,
                nextRunId: 10,
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 100 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

function makeMessageSelection(messageIds: string[]): SelectionResolution {
    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: messageIds[0] }
    const endRef: BoundaryReference = {
        kind: "message",
        rawIndex: messageIds.length - 1,
        messageId: messageIds[messageIds.length - 1],
    }
    return {
        startReference: startRef,
        endReference: endRef,
        messageIds,
        messageTokenById: new Map(messageIds.map((id, i) => [id, 50 * (i + 1)])),
        toolIds: [],
        requiredBlockIds: [],
    }
}

function makeBlockSelection(blockIds: number[]): SelectionResolution {
    const startRef: BoundaryReference = { kind: "compressed-block", rawIndex: 0, blockId: blockIds[0] }
    const endRef: BoundaryReference = {
        kind: "compressed-block",
        rawIndex: blockIds.length - 1,
        blockId: blockIds[blockIds.length - 1],
    }
    return {
        startReference: startRef,
        endReference: endRef,
        messageIds: [],
        messageTokenById: new Map(),
        toolIds: [],
        requiredBlockIds: blockIds,
    }
}

function makeInput(overrides: Partial<CompressionStateInput> = {}): CompressionStateInput {
    return {
        topic: "test",
        batchTopic: undefined,
        startId: "m00010",
        endId: "m00020",
        runId: 10,
        compressMessageId: "comp-10",
        compressCallId: "call-10",
        summaryTokens: 100,
        ...overrides,
    }
}

function seedBlock(state: SessionState, block: CompressionBlock): void {
    state.prune.messages.blocksById.set(block.blockId, block)
    state.prune.messages.activeBlockIds.add(block.blockId)
    state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
    for (const msgId of block.effectiveMessageIds) {
        let entry = state.prune.messages.byMessageId.get(msgId)
        if (!entry) {
            entry = { activeBlockIds: [], allBlockIds: [] }
            state.prune.messages.byMessageId.set(msgId, entry)
        }
        entry.activeBlockIds.push(block.blockId)
        entry.allBlockIds.push(block.blockId)
    }
}

const DEFAULT_GC = {
    algorithm: "truncate" as const,
    promotionThreshold: 5,
    maxBlockAge: 15,
    maxOldGenSummaryLength: 3000,
    majorGcThresholdPercent: "100%",
}

// --- T1: message boundaries ---

test("T1 compression with message boundaries gets tier=1 even when consuming old T1 block", () => {
    const state = makeState()
    const oldBlock = makeBlock({
        blockId: 5,
        tier: 1,
        effectiveMessageIds: ["msg-1", "msg-2", "msg-3"],
        directMessageIds: ["msg-1", "msg-2", "msg-3"],
    })
    seedBlock(state, oldBlock)

    const summary = wrapCompressedSummary(10, "New T1 summary covering msg-1 through msg-5.")
    const result = applyCompressionState(
        state,
        makeInput({ startId: "m00010", endId: "m00014" }),
        makeMessageSelection(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]),
        "anchor-10",
        10,
        summary,
        [5],
        DEFAULT_GC,
    )

    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 1, "T1 compression with message boundaries must be tier=1")
    assert.ok(result.newlyCompressedMessageIds.length > 0, "Should have newly compressed messages")
})

test("T1 compression with no consumed blocks gets tier=1", () => {
    const state = makeState()
    const summary = wrapCompressedSummary(10, "Fresh T1 summary.")
    applyCompressionState(
        state,
        makeInput(),
        makeMessageSelection(["msg-a", "msg-b"]),
        "anchor-10",
        10,
        summary,
        [],
        DEFAULT_GC,
    )

    const block = state.prune.messages.blocksById.get(10)!
    assert.equal(block.tier, 1)
})

test("T1 compression consuming old T1 block deactivates the old block", () => {
    const state = makeState()
    const oldBlock = makeBlock({
        blockId: 5,
        tier: 1,
        effectiveMessageIds: ["msg-1", "msg-2"],
        directMessageIds: ["msg-1", "msg-2"],
    })
    seedBlock(state, oldBlock)

    const summary = wrapCompressedSummary(10, "Newer T1 summary replacing old block.")
    applyCompressionState(
        state,
        makeInput(),
        makeMessageSelection(["msg-1", "msg-2", "msg-3"]),
        "anchor-10",
        10,
        summary,
        [5],
        DEFAULT_GC,
    )

    assert.equal(
        state.prune.messages.blocksById.get(5)!.active,
        false,
        "Old T1 block should be deactivated when consumed by new T1 block",
    )
    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 1)
    assert.ok(
        newBlock.effectiveMessageIds.includes("msg-1"),
        "New T1 block should inherit old block's effective messages",
    )
    assert.ok(
        newBlock.effectiveMessageIds.includes("msg-3"),
        "New T1 block should include its own direct messages",
    )
})

// --- T2: block boundaries ---

test("T2 compression with block boundaries consuming T1 blocks gets tier=2", () => {
    const state = makeState()
    const t1a = makeBlock({
        blockId: 1,
        tier: 1,
        effectiveMessageIds: ["msg-1", "msg-2"],
        directMessageIds: ["msg-1", "msg-2"],
    })
    const t1b = makeBlock({
        blockId: 2,
        tier: 1,
        effectiveMessageIds: ["msg-3", "msg-4"],
        directMessageIds: ["msg-3", "msg-4"],
    })
    seedBlock(state, t1a)
    seedBlock(state, t1b)

    const summary = wrapCompressedSummary(10, "T2 distillation of b1 and b2.")
    applyCompressionState(
        state,
        makeInput({ startId: "b1", endId: "b2" }),
        makeBlockSelection([1, 2]),
        "anchor-10",
        10,
        summary,
        [1, 2],
        DEFAULT_GC,
    )

    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 2, "T2 compression with block boundaries must be tier=2")
    assert.equal(state.prune.messages.blocksById.get(1)!.active, false, "T1 block b1 consumed")
    assert.equal(state.prune.messages.blocksById.get(2)!.active, false, "T1 block b2 consumed")
})

// --- T3: block boundaries consuming T2 ---

test("T3 compression with block boundaries consuming T2 blocks gets tier=3", () => {
    const state = makeState()
    const t2a = makeBlock({
        blockId: 1,
        tier: 2,
        effectiveMessageIds: ["msg-1", "msg-2"],
        directMessageIds: [],
        consumedBlockIds: [],
    })
    const t2b = makeBlock({
        blockId: 2,
        tier: 2,
        effectiveMessageIds: ["msg-3", "msg-4"],
        directMessageIds: [],
        consumedBlockIds: [],
    })
    seedBlock(state, t2a)
    seedBlock(state, t2b)

    const summary = wrapCompressedSummary(10, "T3 condensation of b1 and b2.")
    applyCompressionState(
        state,
        makeInput({ startId: "b1", endId: "b2" }),
        makeBlockSelection([1, 2]),
        "anchor-10",
        10,
        summary,
        [1, 2],
        DEFAULT_GC,
    )

    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 3, "T3 compression consuming T2 blocks must be tier=3")
})

// --- Mixed boundary ---

test("mixed boundary (message start, block end) treated as T2+", () => {
    const state = makeState()
    const t1 = makeBlock({
        blockId: 1,
        tier: 1,
        effectiveMessageIds: ["msg-1", "msg-2"],
        directMessageIds: ["msg-1", "msg-2"],
    })
    seedBlock(state, t1)

    const mixedSelection: SelectionResolution = {
        startReference: { kind: "message", rawIndex: 0, messageId: "msg-1" },
        endReference: { kind: "compressed-block", rawIndex: 0, blockId: 1 },
        messageIds: ["msg-1", "msg-2"],
        messageTokenById: new Map([["msg-1", 50], ["msg-2", 60]]),
        toolIds: [],
        requiredBlockIds: [1],
    }

    const summary = wrapCompressedSummary(10, "Mixed boundary summary.")
    applyCompressionState(
        state,
        makeInput({ startId: "m00010", endId: "b1" }),
        mixedSelection,
        "anchor-10",
        10,
        summary,
        [1],
        DEFAULT_GC,
    )

    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 2, "Mixed boundary should be T2+ (any block boundary → T2+)")
})

// --- Regression: the original bug scenario ---

test("regression: T1 compressing 88 messages with 1 incidental T1 overlap → tier=1 not tier=2", () => {
    const state = makeState()

    // Old T1 block covering messages 50-60 (inside the new range 10-100)
    const oldT1 = makeBlock({
        blockId: 6,
        tier: 1,
        effectiveMessageIds: Array.from({ length: 11 }, (_, i) => `msg-${50 + i}`),
        directMessageIds: Array.from({ length: 11 }, (_, i) => `msg-${50 + i}`),
    })
    seedBlock(state, oldT1)

    // New T1 compression covering messages 10-100 (incidentally includes oldT1's range)
    const allMsgs = Array.from({ length: 91 }, (_, i) => `msg-${10 + i}`)
    const summary = wrapCompressedSummary(10, "Large T1 compression with 91 messages.")
    applyCompressionState(
        state,
        makeInput({ startId: "m00010", endId: "m00100" }),
        makeMessageSelection(allMsgs),
        "anchor-10",
        10,
        summary,
        [6],
        DEFAULT_GC,
    )

    const newBlock = state.prune.messages.blocksById.get(10)!
    assert.equal(newBlock.tier, 1, "Must be tier=1 — message boundaries, not distilling summaries")
    assert.equal(
        state.prune.messages.blocksById.get(6)!.active,
        false,
        "Old T1 block consumed (superseded by new T1 covering same range)",
    )
    assert.ok(
        newBlock.effectiveMessageIds.length >= 91,
        "New block should include all 91 messages (own + inherited from old block)",
    )
})
