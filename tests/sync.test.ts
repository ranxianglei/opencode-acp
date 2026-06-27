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
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
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

test("syncCompressionBlocks deactivates block when anchor message is deleted", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, false, "block should be deactivated")
    assert.ok(!state.prune.messages.activeBlockIds.has(1))
    assert.ok(block.deactivatedAt !== undefined)
})

test("syncCompressionBlocks keeps block active when anchor is in byMessageId but not in messages", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1" }))
    state.prune.messages.byMessageId.set("m1", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1), "block should stay active when anchor tracked in byMessageId")
})

test("syncCompressionBlocks deactivates user-deactivated blocks", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1", deactivatedByUser: true }))
    const messages = [userMsg("m1")]
    syncCompressionBlocks(state, logger, messages)
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, false, "user-deactivated block should be inactive")
    assert.ok(!state.prune.messages.activeBlockIds.has(1))
})

test("syncCompressionBlocks deactivates consumed blocks when parent is active", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1", createdAt: 1 }))
    state.prune.messages.blocksById.set(2, makeBlock({ blockId: 2, anchorMessageId: "m3", consumedBlockIds: [1], createdAt: 2 }))
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
    state.prune.messages.byMessageId.set("m2", { tokenCount: 200, allBlockIds: [1], activeBlockIds: [1] })
    const messages = [userMsg("m2")]
    syncCompressionBlocks(state, logger, messages)
    const entry2 = state.prune.messages.byMessageId.get("m2")!
    assert.equal(entry2.activeBlockIds.length, 0, "m2 activeBlockIds should be empty after block deactivated (anchor m1 gone)")
})

test("syncCompressionBlocks processes blocks in creation order", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(2, makeBlock({ blockId: 2, anchorMessageId: "m3", createdAt: 200 }))
    state.prune.messages.blocksById.set(1, makeBlock({ blockId: 1, anchorMessageId: "m1", createdAt: 100 }))
    const messages = [userMsg("m1"), userMsg("m3")]
    syncCompressionBlocks(state, logger, messages)
    assert.ok(state.prune.messages.activeBlockIds.has(1))
    assert.ok(state.prune.messages.activeBlockIds.has(2))
})
