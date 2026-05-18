import assert from "node:assert/strict"
import test from "node:test"
import {
    createPruneMessagesState,
    serializePruneMessagesState,
    loadPruneMap,
    loadPruneMessagesState,
} from "../lib/state/utils"

test("createPruneMessagesState returns initial state with empty maps/sets and counter=1", () => {
    const state = createPruneMessagesState()
    assert.equal(state.nextBlockId, 1)
    assert.equal(state.nextRunId, 1)
    assert.equal(state.byMessageId.size, 0)
    assert.equal(state.blocksById.size, 0)
    assert.equal(state.activeBlockIds.size, 0)
    assert.equal(state.activeByAnchorMessageId.size, 0)
})

test("serializePruneMessagesState converts Maps to Records, Sets to Arrays", () => {
    const state = createPruneMessagesState()
    state.byMessageId.set("msg-1", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 500,
        summaryTokens: 50,
        durationMs: 100,
        mode: "range",
        topic: "test",
        batchTopic: "",
        startId: "s1",
        endId: "e1",
        anchorMessageId: "a1",
        compressMessageId: "c1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 0,
        summary: "summary text",
        survivedCount: 0,
        generation: "young",
    })
    state.activeBlockIds.add(1)
    state.activeByAnchorMessageId.set("a1", 1)

    const serialized = serializePruneMessagesState(state)

    assert.equal(typeof serialized.byMessageId, "object")
    assert.ok(!Array.isArray(serialized.byMessageId))
    assert.ok("msg-1" in serialized.byMessageId)

    assert.ok("1" in serialized.blocksById)

    assert.ok(Array.isArray(serialized.activeBlockIds))
    assert.deepEqual(serialized.activeBlockIds, [1])

    assert.equal(typeof serialized.activeByAnchorMessageId, "object")
    assert.ok(!Array.isArray(serialized.activeByAnchorMessageId))

    assert.equal(serialized.nextBlockId, 1)
    assert.equal(serialized.nextRunId, 1)
})

test("loadPruneMap converts Record to Map", () => {
    const record = { a: 1, b: 2, c: 3 }
    const map = loadPruneMap(record)
    assert.equal(map instanceof Map, true)
    assert.equal(map.size, 3)
    assert.equal(map.get("a"), 1)
    assert.equal(map.get("b"), 2)
    assert.equal(map.get("c"), 3)
})

test("loadPruneMap handles undefined input (returns empty Map)", () => {
    const map = loadPruneMap(undefined)
    assert.equal(map instanceof Map, true)
    assert.equal(map.size, 0)
})

test("loadPruneMap handles null input (returns empty Map)", () => {
    const map = loadPruneMap(null as any)
    assert.equal(map instanceof Map, true)
    assert.equal(map.size, 0)
})

test("loadPruneMap filters invalid entries", () => {
    const record: Record<string, any> = { valid: 42, badString: "not-a-number", badNull: null }
    const map = loadPruneMap(record)
    assert.equal(map.size, 1)
    assert.equal(map.get("valid"), 42)
    assert.equal(map.has("badString"), false)
    assert.equal(map.has("badNull"), false)
})

test("loadPruneMap handles empty object", () => {
    const map = loadPruneMap({})
    assert.equal(map.size, 0)
})

test("loadPruneMessagesState round-trips with serialize", () => {
    const original = createPruneMessagesState()
    original.byMessageId.set("msg-1", { tokenCount: 200, allBlockIds: [1, 2], activeBlockIds: [1] })
    original.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 200,
        mode: "range",
        topic: "test topic",
        batchTopic: "",
        startId: "s1",
        endId: "e1",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1234567890,
        summary: "test summary content",
        survivedCount: 3,
        generation: "old",
    })
    original.activeBlockIds.add(1)
    original.activeByAnchorMessageId.set("anchor-1", 1)

    const serialized = serializePruneMessagesState(original)
    const restored = loadPruneMessagesState(serialized as any)

    assert.equal(restored.byMessageId.size, 1)
    assert.equal(restored.blocksById.size, 1)
    assert.equal(restored.activeBlockIds.size, 1)
    assert.ok(restored.activeBlockIds.has(1))

    const entry = restored.byMessageId.get("msg-1")!
    assert.equal(entry.tokenCount, 200)
    assert.deepEqual(entry.allBlockIds, [1, 2])
    assert.deepEqual(entry.activeBlockIds, [1])

    const block = restored.blocksById.get(1)!
    assert.equal(block.blockId, 1)
    assert.equal(block.active, true)
    assert.equal(block.summary, "test summary content")
    assert.equal(block.topic, "test topic")
    assert.equal(block.generation, "old")
    assert.equal(block.survivedCount, 3)
    assert.equal(block.compressedTokens, 1000)
})

test("loadPruneMessagesState handles undefined input (returns initial state)", () => {
    const state = loadPruneMessagesState(undefined)
    assert.equal(state.byMessageId.size, 0)
    assert.equal(state.blocksById.size, 0)
    assert.equal(state.activeBlockIds.size, 0)
    assert.equal(state.nextBlockId, 1)
    assert.equal(state.nextRunId, 1)
})

test("loadPruneMessagesState handles malformed data gracefully", () => {
    const state = loadPruneMessagesState({ bad: true } as any)
    assert.equal(state.byMessageId.size, 0)
    assert.equal(state.blocksById.size, 0)
    assert.equal(state.nextBlockId, 1)
    assert.equal(state.nextRunId, 1)
})

test("loadPruneMessagesState handles corrupted nextBlockId", () => {
    const state = loadPruneMessagesState({ nextBlockId: -5, nextRunId: "bad" } as any)
    assert.equal(state.nextBlockId, 1)
    assert.equal(state.nextRunId, 1)
})

test("loadPruneMessagesState skips invalid block entries", () => {
    const persisted = {
        byMessageId: {},
        blocksById: {
            "not-a-number": { active: true },
            "-1": { active: true },
            "0": { active: true },
        },
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
    }
    const state = loadPruneMessagesState(persisted as any)
    assert.equal(state.blocksById.size, 0)
})

test("loadPruneMessagesState skips invalid message entries", () => {
    const persisted = {
        byMessageId: {
            "msg-1": null,
            "msg-2": "invalid",
            "msg-3": { tokenCount: 50, allBlockIds: [1], activeBlockIds: [1] },
        },
        blocksById: {},
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
    }
    const state = loadPruneMessagesState(persisted as any)
    assert.equal(state.byMessageId.size, 1)
    assert.ok(state.byMessageId.has("msg-3"))
})

test("loadPruneMessagesState rebuilds activeBlockIds from blocks", () => {
    const persisted = {
        byMessageId: {},
        blocksById: {
            "1": {
                blockId: 1,
                runId: 1,
                active: true,
                deactivatedByUser: false,
                compressedTokens: 0,
                summaryTokens: 10,
                durationMs: 0,
                topic: "",
                batchTopic: "",
                startId: "",
                endId: "",
                anchorMessageId: "anchor-1",
                compressMessageId: "",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 0,
                summary: "summary",
                survivedCount: 0,
            },
            "2": {
                blockId: 2,
                runId: 2,
                active: false,
                deactivatedByUser: false,
                compressedTokens: 0,
                summaryTokens: 10,
                durationMs: 0,
                topic: "",
                batchTopic: "",
                startId: "",
                endId: "",
                anchorMessageId: "",
                compressMessageId: "",
                includedBlockIds: [],
                consumedBlockIds: [],
                parentBlockIds: [],
                directMessageIds: [],
                directToolIds: [],
                effectiveMessageIds: [],
                effectiveToolIds: [],
                createdAt: 0,
                summary: "summary",
                survivedCount: 0,
            },
        },
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
    }
    const state = loadPruneMessagesState(persisted as any)
    assert.ok(state.activeBlockIds.has(1))
    assert.ok(!state.activeBlockIds.has(2))
    assert.equal(state.activeByAnchorMessageId.get("anchor-1"), 1)
})
