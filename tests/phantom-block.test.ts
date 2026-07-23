import assert from "node:assert/strict"
import test from "node:test"
import { checkPhantomBlock } from "../lib/compress/pipeline"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "test",
        startId: "m00001",
        endId: "m00003",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a", "msg-b"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A summary.",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: "phantom-test",
        isSubAgent: false,
        manualMode: false,
        compressPermission: "allow",
        pendingManualTrigger: null,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map<string, PrunedMessageEntry>(),
                blocksById: new Map(),
                activeBlockIds: new Set<number>(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
                nextRunId: 1,
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
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
        ...overrides,
    }
}

function activateMessage(state: SessionState, messageId: string, blockId: number, tokenCount = 50): void {
    const existing = state.prune.messages.byMessageId.get(messageId)
    if (existing) {
        if (!existing.allBlockIds.includes(blockId)) existing.allBlockIds.push(blockId)
        if (!existing.activeBlockIds.includes(blockId)) existing.activeBlockIds.push(blockId)
    } else {
        state.prune.messages.byMessageId.set(messageId, {
            tokenCount,
            allBlockIds: [blockId],
            activeBlockIds: [blockId],
        })
    }
}

// --- checkPhantomBlock: returns null when there are new messages ---

test("checkPhantomBlock returns null when all messages are new (not in any block)", () => {
    const state = makeState()
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2", "m3"], consumedBlockIds: [] }])
    assert.equal(result, null)
})

test("checkPhantomBlock returns null when some messages are new among already-active ones", () => {
    const state = makeState()
    activateMessage(state, "m1", 1)
    // m1 is active, m2 is new
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [] }])
    assert.equal(result, null)
})

// --- checkPhantomBlock: returns Error for phantom plans ---

test("checkPhantomBlock returns Error when ALL messages are already active", () => {
    const state = makeState()
    activateMessage(state, "m1", 1)
    activateMessage(state, "m2", 1)
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [] }])
    assert.ok(result instanceof Error)
    assert.match(result!.message, /already-compressed/)
    assert.match(result!.message, /0 new direct messages/)
})

test("checkPhantomBlock returns Error when single message is already compressed (message mode)", () => {
    const state = makeState()
    activateMessage(state, "solo", 5)
    const result = checkPhantomBlock(state, [{ messageIds: ["solo"], consumedBlockIds: [] }])
    assert.ok(result instanceof Error)
    assert.match(result!.message, /already-compressed/)
})

// --- checkPhantomBlock: consumed block scenarios ---

test("checkPhantomBlock returns Error when consuming a block whose messages are all active under it", () => {
    const state = makeState()
    const block = makeBlock({
        blockId: 10,
        effectiveMessageIds: ["m1", "m2"],
        anchorMessageId: "anchor-10",
    })
    state.prune.messages.blocksById.set(10, block)
    state.prune.messages.activeBlockIds.add(10)
    activateMessage(state, "m1", 10)
    activateMessage(state, "m2", 10)

    // Compressing m1+m2 again, consuming block 10 — all messages were already active
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [10] }])
    assert.ok(result instanceof Error)
})

test("checkPhantomBlock returns null when consuming a block plus adding a new message", () => {
    const state = makeState()
    const block = makeBlock({
        blockId: 10,
        effectiveMessageIds: ["m1", "m2"],
        anchorMessageId: "anchor-10",
    })
    state.prune.messages.blocksById.set(10, block)
    state.prune.messages.activeBlockIds.add(10)
    activateMessage(state, "m1", 10)
    activateMessage(state, "m2", 10)

    // m3 is new → not phantom
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2", "m3"], consumedBlockIds: [10] }])
    assert.equal(result, null)
})

test("checkPhantomBlock returns null when a message is active under a non-consumed block but another is new", () => {
    const state = makeState()
    activateMessage(state, "m1", 99) // active under non-consumed block 99
    // m2 is new
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [] }])
    assert.equal(result, null)
})

// --- checkPhantomBlock: multi-plan batches ---

test("checkPhantomBlock returns Error if ANY plan in a batch is phantom", () => {
    const state = makeState()
    // Plan 1: m1 is new → valid
    // Plan 2: m2 is already active → phantom
    activateMessage(state, "m2", 1)
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    assert.ok(result instanceof Error)
    assert.match(result!.message, /range 2/i)
})

test("checkPhantomBlock returns null when all plans in a batch have new messages", () => {
    const state = makeState()
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2", "m3"], consumedBlockIds: [] },
    ])
    assert.equal(result, null)
})

// --- checkPhantomBlock: edge cases ---

test("checkPhantomBlock returns null for empty plans array", () => {
    const state = makeState()
    const result = checkPhantomBlock(state, [])
    assert.equal(result, null)
})

test("checkPhantomBlock returns null when message exists in byMessageId but has empty activeBlockIds", () => {
    const state = makeState()
    // Message was compressed before but its block was deactivated (GC'd)
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 50,
        allBlockIds: [1],
        activeBlockIds: [], // no longer active
    })
    const result = checkPhantomBlock(state, [{ messageIds: ["m1"], consumedBlockIds: [] }])
    assert.equal(result, null)
})

test("checkPhantomBlock error message includes range index for multi-plan batches", () => {
    const state = makeState()
    activateMessage(state, "m3", 1)
    activateMessage(state, "m4", 1)
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
        { messageIds: ["m3", "m4"], consumedBlockIds: [] },
    ])
    assert.ok(result instanceof Error)
    assert.match(result!.message, /range 3/i)
})
