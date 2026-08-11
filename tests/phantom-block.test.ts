import assert from "node:assert/strict"
import test from "node:test"
import {
    buildPhantomErrorMessage,
    buildPhantomSkipNotice,
    checkPhantomBlock,
    identifyPhantomPlans,
    partitionPhantomPlans,
} from "../lib/compress/pipeline"
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
        compressPermission: "allow",
        prune: {
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

function activateMessage(
    state: SessionState,
    messageId: string,
    blockId: number,
    tokenCount = 50,
): void {
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
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1", "m2", "m3"], consumedBlockIds: [] },
    ])
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
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1", "m2", "m3"], consumedBlockIds: [10] },
    ])
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

// --- identifyPhantomPlans: batch-aware diagnostics (issue #290 fix A/C) ---

test("identifyPhantomPlans returns no phantoms when all plans have new messages", () => {
    const state = makeState()
    const result = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2", "m3"], consumedBlockIds: [] },
    ])
    assert.deepEqual(result.phantomIndices, [])
    assert.deepEqual(result.details, [])
})

test("identifyPhantomPlans marks a phantom entry and reports owning block + consumed IDs", () => {
    const state = makeState()
    activateMessage(state, "m2", 7)
    const result = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    assert.deepEqual(result.phantomIndices, [1])
    assert.equal(result.details.length, 1)
    const detail = result.details[0]!
    assert.equal(detail.index, 1)
    assert.deepEqual(detail.consumedMessageIds, ["m2"])
    assert.deepEqual(detail.owningBlockIds, [7])
})

test("identifyPhantomPlans reports ALL phantom entries in a mixed batch (not just the first)", () => {
    const state = makeState()
    activateMessage(state, "m1", 2)
    activateMessage(state, "m3", 3)
    const result = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
        { messageIds: ["m3"], consumedBlockIds: [] },
    ])
    assert.deepEqual(result.phantomIndices, [0, 2])
    assert.equal(result.details.length, 2)
    assert.equal(result.details[0]!.index, 0)
    assert.deepEqual(result.details[0]!.owningBlockIds, [2])
    assert.equal(result.details[1]!.index, 2)
    assert.deepEqual(result.details[1]!.owningBlockIds, [3])
})

test("identifyPhantomPlans keeps the multi-consumed single-tier carve-out (not phantom)", () => {
    const state = makeState()
    const blockA = makeBlock({ blockId: 10, tier: 1, effectiveMessageIds: ["m1", "m2"] })
    const blockB = makeBlock({ blockId: 11, tier: 1, effectiveMessageIds: ["m3", "m4"] })
    state.prune.messages.blocksById.set(10, blockA)
    state.prune.messages.blocksById.set(11, blockB)
    for (const mid of ["m1", "m2", "m3", "m4"]) activateMessage(state, mid, 10)

    const result = identifyPhantomPlans(state, [
        { messageIds: ["m1", "m2", "m3", "m4"], consumedBlockIds: [10, 11] },
    ])
    assert.deepEqual(result.phantomIndices, [])
})

test("identifyPhantomPlans treats deactivated (GC'd) messages as new", () => {
    const state = makeState()
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 50,
        allBlockIds: [1],
        activeBlockIds: [],
    })
    const result = identifyPhantomPlans(state, [{ messageIds: ["m1"], consumedBlockIds: [] }])
    assert.deepEqual(result.phantomIndices, [])
})

test("identifyPhantomPlans dedups owning block IDs across multiple consumed messages", () => {
    const state = makeState()
    activateMessage(state, "m1", 5)
    activateMessage(state, "m2", 5)
    activateMessage(state, "m2", 9)
    const result = identifyPhantomPlans(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [] }])
    assert.deepEqual(result.phantomIndices, [0])
    const detail = result.details[0]!
    assert.deepEqual(detail.owningBlockIds, [5, 9])
})

// --- buildPhantomErrorMessage: diagnostics surface (issue #290 fix C) ---

test("buildPhantomErrorMessage includes entry index, consumed IDs, and owning block refs", () => {
    const msg = buildPhantomErrorMessage([
        { index: 1, consumedMessageIds: ["m2", "m3"], owningBlockIds: [7] },
    ])
    assert.match(msg, /Entry 2/)
    assert.match(msg, /m2, m3/)
    assert.match(msg, /b7/)
    assert.match(msg, /already-compressed/)
    assert.match(msg, /0 new direct messages/)
})

test("buildPhantomErrorMessage lists multiple phantom entries", () => {
    const msg = buildPhantomErrorMessage([
        { index: 0, consumedMessageIds: ["m1"], owningBlockIds: [2] },
        { index: 2, consumedMessageIds: ["m3"], owningBlockIds: [3] },
    ])
    assert.match(msg, /2 compress entries/)
    assert.match(msg, /Entry 1/)
    assert.match(msg, /Entry 3/)
    assert.match(msg, /b2/)
    assert.match(msg, /b3/)
})

test("buildPhantomErrorMessage handles empty owning blocks (stale ref) without throwing", () => {
    const msg = buildPhantomErrorMessage([{ index: 0, consumedMessageIds: [], owningBlockIds: [] }])
    assert.match(msg, /stale ref/)
    assert.match(msg, /Entry 1/)
})

// --- checkPhantomBlock delegation preserved ---

test("checkPhantomBlock delegates to identifyPhantomPlans (first phantom → Error)", () => {
    const state = makeState()
    activateMessage(state, "m2", 1)
    const result = checkPhantomBlock(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    assert.ok(result instanceof Error)
    assert.match(result!.message, /range 2/i)
    assert.match(result!.message, /already-compressed/)
})

test("checkPhantomBlock returns null when identifyPhantomPlans finds nothing", () => {
    const state = makeState()
    activateMessage(state, "m1", 1)
    const result = checkPhantomBlock(state, [{ messageIds: ["m1", "m2"], consumedBlockIds: [] }])
    assert.equal(result, null)
})

// --- partitionPhantomPlans: the batch all-vs-some-vs-clean decision (issue #290) ---

test("partitionPhantomPlans returns clean when no entries are phantom", () => {
    const id = identifyPhantomPlans(makeState(), [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    const partition = partitionPhantomPlans(id, 2)
    assert.deepEqual(partition, { kind: "clean" })
})

test("partitionPhantomPlans returns all-phantom when every entry is phantom", () => {
    const state = makeState()
    activateMessage(state, "m1", 1)
    activateMessage(state, "m2", 1)
    const id = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    assert.deepEqual(id.phantomIndices, [0, 1])
    const partition = partitionPhantomPlans(id, 2)
    assert.equal(partition.kind, "all-phantom")
    if (partition.kind !== "all-phantom") return
    assert.equal(partition.details.length, 2)
    assert.equal(partition.details[0]!.index, 0)
    assert.equal(partition.details[1]!.index, 1)
})

test("partitionPhantomPlans returns partial (drop + notice) when some entries are phantom", () => {
    const state = makeState()
    activateMessage(state, "m2", 1)
    // 3 plans: [0] valid, [1] phantom, [2] valid
    const id = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
        { messageIds: ["m3"], consumedBlockIds: [] },
    ])
    assert.deepEqual(id.phantomIndices, [1])
    const partition = partitionPhantomPlans(id, 3)
    assert.equal(partition.kind, "partial")
    if (partition.kind !== "partial") return
    assert.deepEqual(partition.dropIndices, [1])
    assert.equal(partition.details.length, 1)
    assert.equal(partition.details[0]!.index, 1)
    assert.match(partition.notice, /Skipped 1 already-compressed entry \(#2\)/)
    assert.match(partition.notice, /remaining entries were compressed/)
})

test("partitionPhantomPlans partial with multiple phantoms uses plural + lists all numbers", () => {
    const state = makeState()
    activateMessage(state, "m1", 1)
    activateMessage(state, "m3", 1)
    // 4 plans: [0] phantom, [1] valid, [2] phantom, [3] valid
    const id = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
        { messageIds: ["m3"], consumedBlockIds: [] },
        { messageIds: ["m4"], consumedBlockIds: [] },
    ])
    assert.deepEqual(id.phantomIndices, [0, 2])
    const partition = partitionPhantomPlans(id, 4)
    assert.equal(partition.kind, "partial")
    if (partition.kind !== "partial") return
    assert.deepEqual(partition.dropIndices, [0, 2])
    assert.match(partition.notice, /Skipped 2 already-compressed entries \(#1, #3\)/)
})

test("partitionPhantomPlans partial keeps its original details even when filtered later", () => {
    // Guards against a refactor that re-derives details from the filtered plan
    // list (which would drop the diagnostics for the phantom entries).
    const state = makeState()
    activateMessage(state, "m1", 1)
    const id = identifyPhantomPlans(state, [
        { messageIds: ["m1"], consumedBlockIds: [] },
        { messageIds: ["m2"], consumedBlockIds: [] },
    ])
    const partition = partitionPhantomPlans(id, 2)
    if (partition.kind !== "partial") throw new Error("expected partial")
    // details[0] must describe the DROPPED (phantom) plan, not a surviving one.
    assert.equal(partition.details.length, 1)
    assert.equal(partition.details[0]!.index, 0)
    assert.deepEqual(partition.details[0]!.owningBlockIds, [1])
})

test("buildPhantomSkipNotice singular vs plural", () => {
    assert.match(
        buildPhantomSkipNotice({
            phantomIndices: [3],
            details: [{ index: 3, consumedMessageIds: [], owningBlockIds: [] }],
        }),
        /1 already-compressed entry/,
    )
    assert.match(
        buildPhantomSkipNotice({
            phantomIndices: [0, 2],
            details: [
                { index: 0, consumedMessageIds: [], owningBlockIds: [] },
                { index: 2, consumedMessageIds: [], owningBlockIds: [] },
            ],
        }),
        /2 already-compressed entries \(#1, #3\)/,
    )
})
