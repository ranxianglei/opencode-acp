import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import { snapshotCompressionState, restoreCompressionState } from "../lib/compress/pipeline"
import { applyCompressionState, allocateRunId, allocateBlockId } from "../lib/compress/state"
import type { SelectionResolution, CompressionStateInput } from "../lib/compress/types"

function makeSelection(messageIds: string[], toolIds: string[] = []): SelectionResolution {
    const messageTokenById = new Map<string, number>()
    for (const id of messageIds) {
        messageTokenById.set(id, 100)
    }
    return {
        messageIds,
        toolIds,
        messageTokenById,
        requiredBlockIds: [],
        startReference: { kind: "message", rawIndex: 0 },
        endReference: { kind: "message", rawIndex: 0 },
    }
}

function makeCompressionInput(runId: number, blockId: number): CompressionStateInput {
    return {
        topic: "test",
        batchTopic: "test",
        startId: "m001",
        endId: "m005",
        mode: "range" as const,
        runId,
        compressMessageId: "compress-msg-1",
        compressCallId: undefined,
        summaryTokens: 50,
    }
}

test("snapshotCompressionState captures prune.messages and stats", () => {
    const state = createSessionState()
    state.prune.messages.nextBlockId = 5
    state.prune.messages.nextRunId = 3
    state.stats.pruneTokenCounter = 42
    state.stats.totalPruneTokens = 500

    const snapshot = snapshotCompressionState(state)

    state.prune.messages.nextBlockId = 99
    state.stats.totalPruneTokens = 999

    assert.equal(snapshot.messages.nextBlockId, 5, "snapshot preserves original value")
    assert.equal(snapshot.messages.nextRunId, 3)
    assert.equal(snapshot.stats.pruneTokenCounter, 42)
    assert.equal(snapshot.stats.totalPruneTokens, 500)
})

test("restoreCompressionState fully restores state after mutations", () => {
    const state = createSessionState()
    state.stats.totalPruneTokens = 100

    const selection = makeSelection(["msg-1", "msg-2", "msg-3"])
    const snapshot = snapshotCompressionState(state)

    const runId = allocateRunId(state)
    const blockId = allocateBlockId(state)
    applyCompressionState(
        state,
        makeCompressionInput(runId, blockId),
        selection,
        "anchor-1",
        blockId,
        "[Compressed conversation section]\ntest summary\n\n<b1>",
        [],
    )

    assert.ok(state.prune.messages.blocksById.has(blockId), "block created after apply")
    assert.ok(state.prune.messages.byMessageId.has("msg-1"), "byMessageId populated")
    assert.notEqual(
        state.prune.messages.nextBlockId,
        snapshot.messages.nextBlockId,
        "nextBlockId mutated",
    )

    restoreCompressionState(state, snapshot)

    assert.equal(state.prune.messages.blocksById.size, 0, "blocksById cleared after restore")
    assert.equal(state.prune.messages.byMessageId.size, 0, "byMessageId cleared after restore")
    assert.equal(
        state.prune.messages.activeBlockIds.size,
        0,
        "activeBlockIds cleared after restore",
    )
    assert.equal(state.prune.messages.nextBlockId, 1, "nextBlockId restored to initial")
    assert.equal(state.prune.messages.nextRunId, 1, "nextRunId restored to initial")
    assert.equal(state.stats.totalPruneTokens, 100, "stats restored")
})

test("snapshot is independent — mutating original does not affect snapshot", () => {
    const state = createSessionState()
    const snapshot = snapshotCompressionState(state)

    state.prune.messages.byMessageId.set("test-id", {
        tokenCount: 999,
        allBlockIds: [42],
        activeBlockIds: [42],
    })
    state.prune.messages.blocksById.set(42, {} as any)
    state.prune.messages.activeBlockIds.add(42)

    assert.equal(snapshot.messages.byMessageId.size, 0, "snapshot byMessageId unaffected")
    assert.equal(snapshot.messages.blocksById.size, 0, "snapshot blocksById unaffected")
    assert.equal(snapshot.messages.activeBlockIds.size, 0, "snapshot activeBlockIds unaffected")
})

test("restoreCompressionState creates independent Maps/Sets (no shared references)", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("msg-1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const snapshot = snapshotCompressionState(state)
    restoreCompressionState(state, snapshot)

    state.prune.messages.byMessageId.set("msg-2", {
        tokenCount: 200,
        allBlockIds: [2],
        activeBlockIds: [2],
    })

    assert.equal(
        snapshot.messages.byMessageId.size,
        1,
        "snapshot unaffected by post-restore mutation",
    )
    assert.ok(!snapshot.messages.byMessageId.has("msg-2"), "snapshot has no msg-2")
})
