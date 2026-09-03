import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { createSessionState, type WithParts, type CompressionBlock } from "../lib/state"
import { loadPruneMessagesState, serializePruneMessagesState } from "../lib/state/utils"

const SID = "ses-sync-test"
const logger = new Logger(false)

function makeBlock(overrides: Partial<CompressionBlock> & { blockId: number }): CompressionBlock {
    return {
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 50,
        durationMs: 0,
        topic: "test",
        startId: "m1",
        endId: "m2",
        anchorMessageId: "anchor-1",
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "summary text",
        survivedCount: 0,
        ...overrides,
    } as CompressionBlock
}

function userMsg(id: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "a",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [],
    }
}

test("syncCompressionBlocks is a no-op when no blocks exist", () => {
    const state = createSessionState()
    const messages = [userMsg("m1")]
    syncCompressionBlocks(state, logger, messages)
    assert.equal(state.prune.messages.activeBlockIds.size, 0)
})

test("syncCompressionBlocks keeps block active when anchor message exists", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    const messages = [userMsg("m1"), userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1), "block should be active")
    assert.equal(state.prune.messages.activeByAnchorMessageId.get("m1"), 1)
})

test("syncCompressionBlocks keeps block active when anchor message is deleted", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true, "block should stay active — existence IS proof")
    assert.ok(state.prune.messages.activeBlockIds.has(1))
    assert.equal(block.deactivatedAt, undefined)
})

test("syncCompressionBlocks keeps block active when anchor is gone even if tracked in byMessageId", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true, "block should stay active — existence IS proof")
    assert.ok(state.prune.messages.activeBlockIds.has(1))
})

test("syncCompressionBlocks deactivates user-deactivated blocks", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, anchorMessageId: "m1", deactivatedByUser: true }),
    )
    const messages = [userMsg("m1")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, false, "user-deactivated block should be inactive")
    assert.ok(!state.prune.messages.activeBlockIds.has(1))
})

test("syncCompressionBlocks deactivates consumed blocks when parent is active", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, anchorMessageId: "m1", createdAt: 1 }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({ blockId: 2, anchorMessageId: "m3", consumedBlockIds: [1], createdAt: 2 }),
    )
    state.prune.messages.activeBlockIds.add(1)
    const messages = [userMsg("m1"), userMsg("m3")]
    syncCompressionBlocks(state, logger, messages)
    const block1 = state.prune.messages.blocksById.get(1)!
    const block2 = state.prune.messages.blocksById.get(2)!
    assert.equal(block1.active, false, "consumed block should be deactivated")
    assert.equal(block1.deactivatedByBlockId, 2)
    assert.equal(block2.active, true, "parent block should be active")
})

test("syncCompressionBlocks updates byMessageId activeBlockIds after sync", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    state.prune.messages.byMessageId.set("m2", {
        tokenCount: 200,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const entry2 = state.prune.messages.byMessageId.get("m2")!
    assert.equal(
        entry2.activeBlockIds.length,
        1,
        "m2 activeBlockIds should still have block 1 (block survives anchor removal)",
    )
})

test("syncCompressionBlocks preserves message memberships when active blocks are unchanged", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("m2", {
        tokenCount: 200,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    syncCompressionBlocks(state, logger, [userMsg("m1"), userMsg("m2")])
    const entry = state.prune.messages.byMessageId.get("m2")!
    const activeBlockIds = entry.activeBlockIds

    syncCompressionBlocks(state, logger, [userMsg("m1"), userMsg("m2")])

    assert.strictEqual(
        entry.activeBlockIds,
        activeBlockIds,
        "unchanged active membership must not be rebuilt on every transform",
    )
})

test("syncCompressionBlocks repairs persisted memberships before using the fast path", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("m2", {
        tokenCount: 200,
        allBlockIds: [1],
        activeBlockIds: [],
    })

    syncCompressionBlocks(state, logger, [userMsg("m1"), userMsg("m2")])

    assert.deepEqual(state.prune.messages.byMessageId.get("m2")!.activeBlockIds, [1])
    assert.equal(state.prune.messages.membershipsVerified, true)
})

test("syncCompressionBlocks clears stale persisted memberships when no blocks load", () => {
    const state = createSessionState()
    state.prune.messages = loadPruneMessagesState({
        byMessageId: {
            m2: { tokenCount: 200, allBlockIds: [1], activeBlockIds: [1] },
        },
        blocksById: {},
        activeBlockIds: [1],
        activeByAnchorMessageId: { m2: 1 },
        nextBlockId: 2,
        nextRunId: 2,
    } as any)

    syncCompressionBlocks(state, logger, [userMsg("m2")])

    assert.deepEqual(state.prune.messages.byMessageId.get("m2")!.activeBlockIds, [])
    assert.deepEqual([...state.prune.messages.activeBlockIds], [])
    assert.deepEqual([...state.prune.messages.activeByAnchorMessageId], [])
    assert.equal(state.prune.messages.membershipsVerified, true)
    const persisted = serializePruneMessagesState(state.prune.messages)
    assert.deepEqual(persisted.activeBlockIds, [])
    assert.deepEqual(persisted.activeByAnchorMessageId, {})
})

test("syncCompressionBlocks processes blocks in creation order", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        2,
        makeBlock({ blockId: 2, anchorMessageId: "m3", createdAt: 200 }),
    )
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, anchorMessageId: "m1", createdAt: 100 }),
    )
    const messages = [userMsg("m1"), userMsg("m3")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1))
    assert.ok(state.prune.messages.activeBlockIds.has(2))
})

test("issue #125: external anchor deletion keeps block active (anchor-survival fix)", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "anchor-1" }))
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("anchor-1", 1)
    state.prune.messages.byMessageId.set("anchor-1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("surviving-msg", {
        tokenCount: 200,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const messages = [userMsg("surviving-msg")]

    syncCompressionBlocks(state, logger, messages)

    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true, "block stays active — existence IS proof")

    const survivingEntry = state.prune.messages.byMessageId.get("surviving-msg")!
    assert.equal(
        survivingEntry.activeBlockIds.length,
        1,
        "surviving message still has block 1 active",
    )
})
