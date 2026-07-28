import assert from "node:assert/strict"
import test from "node:test"
import { getActiveSummaryTokenUsage, createPruneMessagesState } from "../lib/state/utils"
import type { CompressionBlock, SessionState } from "../lib/state/types"

function makeBlock(overrides: Partial<CompressionBlock> & { blockId: number }): CompressionBlock {
    return {
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "",
        startId: "s1",
        endId: "e1",
        anchorMessageId: "anchor-1",
        compressMessageId: "compress-1",
        compressCallId: undefined,
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
        generation: "young",
        ...overrides,
    }
}

function buildSessionState(blocks: CompressionBlock[]): Pick<SessionState, "prune"> {
    const pruneMessages = createPruneMessagesState()
    for (const block of blocks) {
        pruneMessages.blocksById.set(block.blockId, block)
        if (block.active) {
            pruneMessages.activeBlockIds.add(block.blockId)
        }
    }
    return { prune: { messages: pruneMessages } }
}

test("getActiveSummaryTokenUsage: sums all active blocks without visibility filter", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100 }),
        makeBlock({ blockId: 2, summaryTokens: 200 }),
        makeBlock({ blockId: 3, summaryTokens: 300 }),
    ])
    assert.equal(getActiveSummaryTokenUsage(state as SessionState), 600)
})

test("getActiveSummaryTokenUsage: skips inactive blocks", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100, active: true }),
        makeBlock({ blockId: 2, summaryTokens: 200, active: false }),
    ])
    assert.equal(getActiveSummaryTokenUsage(state as SessionState), 100)
})

test("getActiveSummaryTokenUsage: filters by visibleMessageIds", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100, compressMessageId: "msg-A" }),
        makeBlock({ blockId: 2, summaryTokens: 200, compressMessageId: "msg-B" }),
        makeBlock({ blockId: 3, summaryTokens: 300, compressMessageId: "msg-C" }),
    ])
    const visible = new Set(["msg-A", "msg-C"])
    assert.equal(getActiveSummaryTokenUsage(state as SessionState, visible), 400)
})

test("getActiveSummaryTokenUsage: empty visibleMessageIds returns 0", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100, compressMessageId: "msg-A" }),
        makeBlock({ blockId: 2, summaryTokens: 200, compressMessageId: "msg-B" }),
    ])
    const visible = new Set<string>()
    assert.equal(getActiveSummaryTokenUsage(state as SessionState, visible), 0)
})

test("getActiveSummaryTokenUsage: all blocks visible returns same as unfiltered", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100, compressMessageId: "msg-A" }),
        makeBlock({ blockId: 2, summaryTokens: 200, compressMessageId: "msg-B" }),
    ])
    const visible = new Set(["msg-A", "msg-B"])
    assert.equal(getActiveSummaryTokenUsage(state as SessionState, visible), 300)
})

test("getActiveSummaryTokenUsage: blocks without compressMessageId counted when filter provided", () => {
    const state = buildSessionState([
        makeBlock({ blockId: 1, summaryTokens: 100, compressMessageId: undefined }),
        makeBlock({ blockId: 2, summaryTokens: 200, compressMessageId: "msg-B" }),
    ])
    const visible = new Set(["msg-B"])
    assert.equal(getActiveSummaryTokenUsage(state as SessionState, visible), 300)
})

test("getActiveSummaryTokenUsage: simulates 448-block session with only 26 visible", () => {
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 448; i++) {
        blocks.push(
            makeBlock({
                blockId: i,
                summaryTokens: 340,
                compressMessageId: `msg-${i}`,
            }),
        )
    }
    const state = buildSessionState(blocks)

    const allVisible = new Set<string>()
    for (let i = 1; i <= 448; i++) allVisible.add(`msg-${i}`)
    const recentVisible = new Set<string>()
    for (let i = 423; i <= 448; i++) recentVisible.add(`msg-${i}`)

    const withoutFilter = getActiveSummaryTokenUsage(state as SessionState)
    const withAllVisible = getActiveSummaryTokenUsage(state as SessionState, allVisible)
    const withRecentOnly = getActiveSummaryTokenUsage(state as SessionState, recentVisible)

    assert.equal(withoutFilter, 448 * 340)
    assert.equal(withAllVisible, 448 * 340)
    assert.equal(withRecentOnly, 26 * 340)
    assert.ok(withRecentOnly < withoutFilter * 0.1)
})
