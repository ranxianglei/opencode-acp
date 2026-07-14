import assert from "node:assert/strict"
import test from "node:test"
import {
    allocateBlockId,
    allocateRunId,
    wrapCompressedSummary,
    applyCompressionState,
    COMPRESSED_BLOCK_HEADER,
} from "../lib/compress/state"
import type { CompressionStateInput, SelectionResolution } from "../lib/compress/types"
import type { BoundaryReference } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"
import type { GCConfig } from "../lib/config"

// --- Factory helpers ---

const SID = "session-state-test"

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
        sessionId: SID,
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
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
        ...overrides,
    }
}

function makeSelection(overrides: Partial<SelectionResolution> = {}): SelectionResolution {
    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "msg-a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 1, messageId: "msg-b" }
    return {
        startReference: startRef,
        endReference: endRef,
        messageIds: ["msg-a", "msg-b"],
        messageTokenById: new Map([
            ["msg-a", 50],
            ["msg-b", 60],
        ]),
        toolIds: [],
        requiredBlockIds: [],
        ...overrides,
    }
}

function makeCompressionInput(
    overrides: Partial<CompressionStateInput> = {},
): CompressionStateInput {
    return {
        topic: "test topic",
        batchTopic: "batch topic",
        startId: "m00001",
        endId: "m00002",
        mode: "range",
        runId: 1,
        compressMessageId: "comp-1",
        compressCallId: "call-1",
        summaryTokens: 30,
        ...overrides,
    }
}

// --- Tests for allocateBlockId ---

test("allocateBlockId returns sequential IDs starting from 1", () => {
    const state = makeState()
    assert.equal(allocateBlockId(state), 1)
    assert.equal(allocateBlockId(state), 2)
    assert.equal(allocateBlockId(state), 3)
})

test("allocateBlockId resets counter when nextBlockId is invalid", () => {
    const state = makeState()
    state.prune.messages.nextBlockId = 0
    assert.equal(allocateBlockId(state), 1)
    assert.equal(state.prune.messages.nextBlockId, 2)
})

test("allocateBlockId resets counter when nextBlockId is negative", () => {
    const state = makeState()
    state.prune.messages.nextBlockId = -5
    assert.equal(allocateBlockId(state), 1)
})

test("allocateBlockId resets counter when nextBlockId is non-integer", () => {
    const state = makeState()
    state.prune.messages.nextBlockId = 1.5
    assert.equal(allocateBlockId(state), 1)
})

// --- Tests for allocateRunId ---

test("allocateRunId returns sequential IDs starting from 1", () => {
    const state = makeState()
    assert.equal(allocateRunId(state), 1)
    assert.equal(allocateRunId(state), 2)
    assert.equal(allocateRunId(state), 3)
})

test("allocateRunId resets counter when nextRunId is invalid", () => {
    const state = makeState()
    state.prune.messages.nextRunId = 0
    assert.equal(allocateRunId(state), 1)
    assert.equal(state.prune.messages.nextRunId, 2)
})

// --- Tests for wrapCompressedSummary ---

test("wrapCompressedSummary produces header-body-footer format with block ref", () => {
    const result = wrapCompressedSummary(5, "Some summary text")
    assert.ok(result.startsWith(COMPRESSED_BLOCK_HEADER))
    assert.ok(result.includes("Some summary text"))
    assert.ok(result.includes("<dcp-message-id>b5</dcp-message-id>"))
})

test("wrapCompressedSummary preserves multi-line summary", () => {
    const multilineSummary = "Line one\nLine two\nLine three"
    const result = wrapCompressedSummary(2, multilineSummary)
    assert.ok(result.includes("Line one\nLine two\nLine three"))
    assert.ok(result.includes("<dcp-message-id>b2</dcp-message-id>"))
})

test("wrapCompressedSummary handles empty summary with header and footer only", () => {
    const result = wrapCompressedSummary(1, "  ")
    const expectedFooter = "<dcp-message-id>b1</dcp-message-id>"
    assert.ok(result.startsWith(COMPRESSED_BLOCK_HEADER))
    assert.ok(result.endsWith(expectedFooter))
})

test("wrapCompressedSummary trims whitespace from summary", () => {
    const result = wrapCompressedSummary(3, "  padded summary  ")
    assert.ok(result.includes("padded summary"))
    assert.ok(!result.includes("  padded summary"))
})

// --- Tests for applyCompressionState ---

test("applyCompressionState creates a new block in blocksById", () => {
    const state = makeState()
    const input = makeCompressionInput()
    const selection = makeSelection()

    applyCompressionState(state, input, selection, "msg-a", 1, "summary text", [])

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.equal(block!.blockId, 1)
    assert.equal(block!.anchorMessageId, "msg-a")
    assert.equal(block!.summary, "summary text")
    assert.equal(block!.active, true)
    assert.equal(block!.mode, "range")
    assert.equal(block!.topic, "test topic")
})

test("applyCompressionState adds block to activeBlockIds and activeByAnchorMessageId", () => {
    const state = makeState()
    const input = makeCompressionInput()
    const selection = makeSelection()

    applyCompressionState(state, input, selection, "msg-a", 5, "summary", [])

    assert.ok(state.prune.messages.activeBlockIds.has(5))
    assert.equal(state.prune.messages.activeByAnchorMessageId.get("msg-a"), 5)
})

test("applyCompressionState deactivates consumed blocks", () => {
    const state = makeState()
    const consumedBlock = makeBlock({ blockId: 2, anchorMessageId: "anchor-2" })
    state.prune.messages.blocksById.set(2, consumedBlock)
    state.prune.messages.activeBlockIds.add(2)

    const input = makeCompressionInput()
    const selection = makeSelection()

    applyCompressionState(state, input, selection, "msg-a", 3, "summary", [2])

    assert.equal(consumedBlock.active, false)
    assert.ok(!state.prune.messages.activeBlockIds.has(2))
    assert.equal(consumedBlock.deactivatedByBlockId, 3)
})

test("applyCompressionState calculates compressedTokens for newly compressed messages", () => {
    const state = makeState()
    const input = makeCompressionInput()
    const selection = makeSelection({
        messageIds: ["msg-a", "msg-b"],
        messageTokenById: new Map([
            ["msg-a", 50],
            ["msg-b", 60],
        ]),
    })

    const result = applyCompressionState(state, input, selection, "msg-a", 1, "summary", [])

    assert.equal(result.compressedTokens, 110)
    assert.deepEqual(result.messageIds, ["msg-a", "msg-b"])
    assert.deepEqual(result.newlyCompressedMessageIds, ["msg-a", "msg-b"])
})

test("applyCompressionState tracks newlyCompressedMessageIds correctly", () => {
    const state = makeState()
    // Pre-existing: msg-a already has an active block
    state.prune.messages.byMessageId.set("msg-a", {
        tokenCount: 50,
        allBlockIds: [99],
        activeBlockIds: [99],
    })
    const existingBlock = makeBlock({ blockId: 99, anchorMessageId: "old-anchor" })
    state.prune.messages.blocksById.set(99, existingBlock)
    state.prune.messages.activeBlockIds.add(99)

    const input = makeCompressionInput()
    const selection = makeSelection()

    const result = applyCompressionState(state, input, selection, "msg-a", 1, "summary", [99])

    // msg-a was initially active (had activeBlockIds [99]), so it's NOT newly compressed
    assert.ok(!result.newlyCompressedMessageIds.includes("msg-a"))
    // msg-b was NOT initially active, so it IS newly compressed
    assert.ok(result.newlyCompressedMessageIds.includes("msg-b"))
})

test("applyCompressionState updates byMessageId entries for selected messages", () => {
    const state = makeState()
    const input = makeCompressionInput()
    const selection = makeSelection()

    const result = applyCompressionState(state, input, selection, "msg-a", 1, "summary", [])

    const entryA = state.prune.messages.byMessageId.get("msg-a")
    assert.ok(entryA)
    assert.equal(entryA!.tokenCount, 50)
    assert.ok(entryA!.allBlockIds.includes(1))
    assert.ok(entryA!.activeBlockIds.includes(1))

    const entryB = state.prune.messages.byMessageId.get("msg-b")
    assert.ok(entryB)
    assert.equal(entryB!.tokenCount, 60)
})

test("applyCompressionState promotes old-gen blocks when survivedCount exceeds threshold", () => {
    const state = makeState()
    const oldBlock = makeBlock({ blockId: 2, survivedCount: 4 })
    state.prune.messages.blocksById.set(2, oldBlock)
    state.prune.messages.activeBlockIds.add(2)

    const input = makeCompressionInput()
    const selection = makeSelection()

    const gcConfig: GCConfig = {
        algorithm: "truncate",
        promotionThreshold: 5,
        maxBlockAge: 15,
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
    }

    applyCompressionState(state, input, selection, "msg-a", 1, "summary", [], gcConfig)

    assert.equal(oldBlock.survivedCount, 5)
    assert.equal(oldBlock.generation, "old")
})

test("applyCompressionState does not promote blocks below threshold", () => {
    const state = makeState()
    const youngBlock = makeBlock({ blockId: 2, survivedCount: 2 })
    state.prune.messages.blocksById.set(2, youngBlock)
    state.prune.messages.activeBlockIds.add(2)

    const input = makeCompressionInput()
    const selection = makeSelection()

    const gcConfig: GCConfig = {
        algorithm: "truncate",
        promotionThreshold: 5,
        maxBlockAge: 15,
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
    }

    applyCompressionState(state, input, selection, "msg-a", 1, "summary", [], gcConfig)

    assert.equal(youngBlock.survivedCount, 3)
    assert.equal(youngBlock.generation, "young")
})

test("applyCompressionState updates stats pruneTokenCounter", () => {
    const state = makeState()
    const input = makeCompressionInput()
    const selection = makeSelection()

    applyCompressionState(state, input, selection, "msg-a", 1, "summary", [])

    assert.equal(state.stats.pruneTokenCounter, 0)
    assert.equal(state.stats.totalPruneTokens, 110)
})

test("applyCompressionState merges effectiveMessageIds from consumed blocks", () => {
    const state = makeState()
    const consumedBlock = makeBlock({
        blockId: 2,
        anchorMessageId: "anchor-2",
        effectiveMessageIds: ["msg-c", "msg-d"],
        effectiveToolIds: ["tool-x"],
    })
    state.prune.messages.blocksById.set(2, consumedBlock)
    state.prune.messages.activeBlockIds.add(2)

    const input = makeCompressionInput()
    const selection = makeSelection()

    const result = applyCompressionState(state, input, selection, "msg-a", 3, "summary", [2])

    const newBlock = state.prune.messages.blocksById.get(3)
    assert.ok(newBlock)
    assert.ok(newBlock!.effectiveMessageIds.includes("msg-c"))
    assert.ok(newBlock!.effectiveMessageIds.includes("msg-d"))
    assert.ok(newBlock!.effectiveMessageIds.includes("msg-a"))
    assert.ok(newBlock!.effectiveMessageIds.includes("msg-b"))
    assert.ok(newBlock!.effectiveToolIds.includes("tool-x"))
    assert.ok(!result.newlyCompressedToolIds.includes("tool-x"))
})

test("applyCompressionState removes consumed block from byMessageId activeBlockIds", () => {
    const state = makeState()
    const consumedBlock = makeBlock({
        blockId: 2,
        anchorMessageId: "anchor-2",
        effectiveMessageIds: ["msg-a", "msg-c"],
    })
    state.prune.messages.blocksById.set(2, consumedBlock)
    state.prune.messages.activeBlockIds.add(2)
    state.prune.messages.byMessageId.set("msg-a", {
        tokenCount: 50,
        allBlockIds: [2],
        activeBlockIds: [2],
    })
    state.prune.messages.byMessageId.set("msg-c", {
        tokenCount: 30,
        allBlockIds: [2],
        activeBlockIds: [2],
    })

    const input = makeCompressionInput()
    const selection = makeSelection()

    applyCompressionState(state, input, selection, "msg-a", 3, "summary", [2])

    const entryA = state.prune.messages.byMessageId.get("msg-a")
    assert.ok(entryA)
    assert.ok(!entryA!.activeBlockIds.includes(2))
    assert.ok(entryA!.activeBlockIds.includes(3))
})
