import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { createSessionState, type WithParts, type CompressionBlock } from "../lib/state"

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
    const messages = [userMsg("m1"), userMsg("compress-1"), userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1), "block should be active")
    assert.equal(state.prune.messages.activeByAnchorMessageId.get("m1"), 1)
})

test("syncCompressionBlocks keeps block active when anchor message is deleted (compress-as-anchor)", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true, "block stays active — anchor presence no longer checked")
    assert.ok(state.prune.messages.activeBlockIds.has(1))
})

test("syncCompressionBlocks keeps block active when anchor is gone even if tracked in byMessageId (compress-as-anchor)", () => {
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
    assert.equal(
        block.active,
        true,
        "block stays active — compress-as-anchor doesn't check anchor presence",
    )
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
    const messages = [userMsg("m1"), userMsg("compress-1"), userMsg("m3")]
    syncCompressionBlocks(state, logger, messages)
    const block1 = state.prune.messages.blocksById.get(1)!
    const block2 = state.prune.messages.blocksById.get(2)!
    assert.equal(block1.active, false, "consumed block should be deactivated")
    assert.equal(block1.deactivatedByBlockId, 2)
    assert.equal(block2.active, true, "parent block should be active")
})

test("syncCompressionBlocks keeps byMessageId activeBlockIds populated when block stays active (compress-as-anchor)", () => {
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
        "m2 activeBlockIds stays populated — block active even without anchor in messages",
    )
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
    const messages = [userMsg("m1"), userMsg("compress-1"), userMsg("m3")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1))
    assert.ok(state.prune.messages.activeBlockIds.has(2))
})

test("issue #125: compress-as-anchor keeps block active when anchor externally deleted", () => {
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
    assert.equal(block.active, true, "block stays active even when anchor externally deleted")

    const survivingEntry = state.prune.messages.byMessageId.get("surviving-msg")!
    assert.equal(
        survivingEntry.activeBlockIds.length,
        1,
        "surviving message stays hidden — block still active",
    )
})
