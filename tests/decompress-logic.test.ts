import assert from "node:assert/strict"
import test from "node:test"
import {
    parseBlockIdArg,
    findActiveParentBlockId,
    findActiveAncestorBlockId,
    findActiveBlocksOverlappingMessages,
    snapshotActiveMessages,
    deactivateCompressionTarget,
    computeRestoredMessages,
    computeReactivatedBlockIds,
    buildRestoredContentPreview,
} from "../lib/compress/decompress-logic"
import type { CompressionBlock, PruneMessagesState, WithParts } from "../lib/state/types"
import type { CompressionTarget } from "../lib/commands/compression-targets"

// --- Factory helpers ---

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

function makeMessagesState(overrides: Partial<PruneMessagesState> = {}): PruneMessagesState {
    return {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
        ...overrides,
    }
}

function makeTarget(overrides: Partial<CompressionTarget> = {}): CompressionTarget {
    return {
        displayId: 1,
        runId: 1,
        topic: "test topic",
        compressedTokens: 100,
        durationMs: 50,
        grouped: false,
        blocks: [makeBlock()],
        ...overrides,
    }
}

// --- parseBlockIdArg ---

test("parseBlockIdArg returns block ID for 'b1' format", () => {
    assert.equal(parseBlockIdArg("b1"), 1)
})

test("parseBlockIdArg returns block ID for bare number '5'", () => {
    assert.equal(parseBlockIdArg("5"), 5)
})

test("parseBlockIdArg returns null for invalid 'abc'", () => {
    assert.equal(parseBlockIdArg("abc"), null)
})

test("parseBlockIdArg returns null for '0'", () => {
    assert.equal(parseBlockIdArg("0"), null)
})

test("parseBlockIdArg returns null for empty string", () => {
    assert.equal(parseBlockIdArg(""), null)
})

test("parseBlockIdArg returns null for 'b-1'", () => {
    assert.equal(parseBlockIdArg("b-1"), null)
})

test("parseBlockIdArg returns null for 'b0'", () => {
    assert.equal(parseBlockIdArg("b0"), null)
})

test("parseBlockIdArg is case insensitive: 'B3' returns 3", () => {
    assert.equal(parseBlockIdArg("B3"), 3)
})

test("parseBlockIdArg trims whitespace", () => {
    assert.equal(parseBlockIdArg("  b7  "), 7)
})

test("parseBlockIdArg returns null for negative number '-1'", () => {
    assert.equal(parseBlockIdArg("-1"), null)
})

// --- findActiveParentBlockId ---

test("findActiveParentBlockId returns null when block has no parents", () => {
    const ms = makeMessagesState()
    const block = makeBlock({ parentBlockIds: [] })
    assert.equal(findActiveParentBlockId(ms, block), null)
})

test("findActiveParentBlockId returns null when all parents are inactive", () => {
    const parent = makeBlock({ blockId: 2, active: false })
    const ms = makeMessagesState({ blocksById: new Map([[2, parent]]) })
    const block = makeBlock({ parentBlockIds: [2] })
    assert.equal(findActiveParentBlockId(ms, block), null)
})

test("findActiveParentBlockId returns active parent block ID", () => {
    const parent = makeBlock({ blockId: 2, active: true })
    const ms = makeMessagesState({ blocksById: new Map([[2, parent]]) })
    const block = makeBlock({ parentBlockIds: [2] })
    assert.equal(findActiveParentBlockId(ms, block), 2)
})

test("findActiveParentBlockId handles deep ancestor chains (grandparent)", () => {
    const grandparent = makeBlock({ blockId: 10, active: true })
    const parent = makeBlock({ blockId: 5, active: false, parentBlockIds: [10] })
    const ms = makeMessagesState({
        blocksById: new Map([
            [5, parent],
            [10, grandparent],
        ]),
    })
    const block = makeBlock({ parentBlockIds: [5] })
    assert.equal(findActiveParentBlockId(ms, block), 10)
})

test("findActiveParentBlockId handles cycles safely", () => {
    const blockA = makeBlock({ blockId: 1, active: false, parentBlockIds: [2] })
    const blockB = makeBlock({ blockId: 2, active: false, parentBlockIds: [1] })
    const ms = makeMessagesState({
        blocksById: new Map([
            [1, blockA],
            [2, blockB],
        ]),
    })
    assert.equal(findActiveParentBlockId(ms, blockA), null)
})

test("findActiveParentBlockId returns null for missing parent", () => {
    const ms = makeMessagesState({ blocksById: new Map() })
    const block = makeBlock({ parentBlockIds: [99] })
    assert.equal(findActiveParentBlockId(ms, block), null)
})

// --- findActiveAncestorBlockId ---

test("findActiveAncestorBlockId returns null when no blocks have active ancestors", () => {
    const parent = makeBlock({ blockId: 2, active: false })
    const block = makeBlock({ parentBlockIds: [2] })
    const ms = makeMessagesState({ blocksById: new Map([[2, parent]]) })
    const target = makeTarget({ blocks: [block] })
    assert.equal(findActiveAncestorBlockId(ms, target), null)
})

test("findActiveAncestorBlockId returns active ancestor from any block in target", () => {
    const activeParent = makeBlock({ blockId: 10, active: true })
    const block = makeBlock({ parentBlockIds: [10] })
    const ms = makeMessagesState({ blocksById: new Map([[10, activeParent]]) })
    const target = makeTarget({ blocks: [block] })
    assert.equal(findActiveAncestorBlockId(ms, target), 10)
})

// --- snapshotActiveMessages ---

test("snapshotActiveMessages returns empty map when no active messages", () => {
    const ms = makeMessagesState()
    const result = snapshotActiveMessages(ms)
    assert.equal(result.size, 0)
})

test("snapshotActiveMessages returns map of messageId to tokenCount for active messages", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [1] }],
            ["msg-b", { tokenCount: 30, allBlockIds: [2], activeBlockIds: [] }],
        ]),
    })
    const result = snapshotActiveMessages(ms)
    assert.equal(result.size, 1)
    assert.equal(result.get("msg-a"), 50)
    assert.ok(!result.has("msg-b"))
})

// --- deactivateCompressionTarget ---

test("deactivateCompressionTarget sets block.active = false", () => {
    const block = makeBlock({ blockId: 1, active: true })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const target = makeTarget({ blocks: [block] })
    deactivateCompressionTarget(ms, target)
    assert.equal(block.active, false)
})

test("deactivateCompressionTarget sets block.deactivatedByUser = true", () => {
    const block = makeBlock({ blockId: 1, deactivatedByUser: false })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const target = makeTarget({ blocks: [block] })
    deactivateCompressionTarget(ms, target)
    assert.equal(block.deactivatedByUser, true)
})

test("deactivateCompressionTarget sets block.deactivatedAt to a number", () => {
    const block = makeBlock({ blockId: 1 })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const target = makeTarget({ blocks: [block] })
    const before = Date.now()
    deactivateCompressionTarget(ms, target)
    assert.ok(typeof block.deactivatedAt === "number")
    assert.ok(block.deactivatedAt! >= before)
})

test("deactivateCompressionTarget clears block.deactivatedByBlockId", () => {
    const block = makeBlock({ blockId: 1, deactivatedByBlockId: 99 })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const target = makeTarget({ blocks: [block] })
    deactivateCompressionTarget(ms, target)
    assert.equal(block.deactivatedByBlockId, undefined)
})

test("deactivateCompressionTarget marks consumed inner blocks deactivatedByUser = true", () => {
    const consumedBlock = makeBlock({ blockId: 2, deactivatedByUser: false })
    const block = makeBlock({ blockId: 1, consumedBlockIds: [2] })
    const ms = makeMessagesState({
        blocksById: new Map([
            [1, block],
            [2, consumedBlock],
        ]),
    })
    const target = makeTarget({ blocks: [block] })
    deactivateCompressionTarget(ms, target)
    assert.equal(consumedBlock.deactivatedByUser, true)
})

test("deactivateCompressionTarget handles target with multiple blocks", () => {
    const block1 = makeBlock({ blockId: 1, active: true, deactivatedByUser: false })
    const block2 = makeBlock({ blockId: 2, active: true, deactivatedByUser: false })
    const ms = makeMessagesState({
        blocksById: new Map([
            [1, block1],
            [2, block2],
        ]),
    })
    const target = makeTarget({ blocks: [block1, block2] })
    deactivateCompressionTarget(ms, target)
    assert.equal(block1.active, false)
    assert.equal(block2.active, false)
    assert.equal(block1.deactivatedByUser, true)
    assert.equal(block2.deactivatedByUser, true)
})

// --- computeRestoredMessages ---

test("computeRestoredMessages returns zero when no messages restored", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [1] }],
        ]),
    })
    const before = new Map([["msg-a", 50]])
    const result = computeRestoredMessages(ms, before)
    assert.equal(result.restoredMessageCount, 0)
    assert.equal(result.restoredTokens, 0)
})

test("computeRestoredMessages counts messages that went from active to inactive", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [] }],
            ["msg-b", { tokenCount: 30, allBlockIds: [2], activeBlockIds: [] }],
        ]),
    })
    const before = new Map([
        ["msg-a", 50],
        ["msg-b", 30],
    ])
    const result = computeRestoredMessages(ms, before)
    assert.equal(result.restoredMessageCount, 2)
    assert.equal(result.restoredTokens, 80)
})

test("computeRestoredMessages handles messages removed from byMessageId entirely", () => {
    const ms = makeMessagesState({ byMessageId: new Map() })
    const before = new Map([["msg-gone", 40]])
    const result = computeRestoredMessages(ms, before)
    assert.equal(result.restoredMessageCount, 1)
    assert.equal(result.restoredTokens, 40)
})

// --- computeReactivatedBlockIds ---

test("computeReactivatedBlockIds returns empty array when no blocks reactivated", () => {
    const ms = makeMessagesState({ activeBlockIds: new Set([1, 2]) })
    const before = new Set([1, 2])
    const result = computeReactivatedBlockIds(ms, before)
    assert.deepEqual(result, [])
})

test("computeReactivatedBlockIds returns sorted list of newly reactivated block IDs", () => {
    const ms = makeMessagesState({ activeBlockIds: new Set([1, 3, 5]) })
    const before = new Set([1])
    const result = computeReactivatedBlockIds(ms, before)
    assert.deepEqual(result, [3, 5])
})

// --- buildRestoredContentPreview ---

test("buildRestoredContentPreview returns empty string when no messages restored", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [1] }],
        ]),
    })
    const before = new Map([["msg-a", 50]])
    const messages: WithParts[] = [
        { info: { id: "msg-a", role: "user" } as any, parts: [{ text: "hello" }] as any },
    ]
    assert.equal(buildRestoredContentPreview(messages, before, ms), "")
})

test("buildRestoredContentPreview returns preview with role and truncated content", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [] }],
        ]),
    })
    const before = new Map([["msg-a", 50]])
    const messages: WithParts[] = [
        { info: { id: "msg-a", role: "user" } as any, parts: [{ text: "Hello world" }] as any },
    ]
    const result = buildRestoredContentPreview(messages, before, ms)
    assert.ok(result.includes("[user]"))
    assert.ok(result.includes("Hello world"))
})

test("buildRestoredContentPreview truncates individual messages at ~200 chars", () => {
    const longText = "A".repeat(300)
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [] }],
        ]),
    })
    const before = new Map([["msg-a", 50]])
    const messages: WithParts[] = [
        { info: { id: "msg-a", role: "assistant" } as any, parts: [{ text: longText }] as any },
    ]
    const result = buildRestoredContentPreview(messages, before, ms)
    // The line should contain "[assistant]" and the truncated text (200 chars + "...")
    const line = result.split("\n")[0]
    assert.ok(line.length < 250)
    assert.ok(line.includes("..."))
})

test("buildRestoredContentPreview caps total output at approximately 2000 chars", () => {
    const ms = makeMessagesState({
        byMessageId: new Map(),
    })
    const before = new Map<string, number>()
    const messages: WithParts[] = []

    // Create 20 messages, each with 200 chars
    for (let i = 0; i < 20; i++) {
        const id = `msg-${i}`
        ms.byMessageId.set(id, { tokenCount: 10, allBlockIds: [1], activeBlockIds: [] })
        before.set(id, 10)
        messages.push({
            info: { id, role: "assistant" } as any,
            parts: [{ text: "B".repeat(200) }] as any,
        })
    }

    const result = buildRestoredContentPreview(messages, before, ms)
    assert.ok(result.length < 2200, `Expected ~2000 chars, got ${result.length}`)
})

test("buildRestoredContentPreview handles messages with no parts", () => {
    const ms = makeMessagesState({
        byMessageId: new Map([
            ["msg-a", { tokenCount: 50, allBlockIds: [1], activeBlockIds: [] }],
        ]),
    })
    const before = new Map([["msg-a", 50]])
    const messages: WithParts[] = [
        { info: { id: "msg-a", role: "user" } as any, parts: [] as any },
    ]
    const result = buildRestoredContentPreview(messages, before, ms)
    assert.ok(result.includes("[user]"))
})

// --- findActiveBlocksOverlappingMessages ---

test("findActiveBlocksOverlappingMessages returns empty array for empty message set", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    assert.deepEqual(findActiveBlocksOverlappingMessages(ms, new Set()), [])
})

test("findActiveBlocksOverlappingMessages returns empty array when no blocks exist", () => {
    const ms = makeMessagesState({ blocksById: new Map() })
    assert.deepEqual(findActiveBlocksOverlappingMessages(ms, new Set(["msg-a"])), [])
})

test("findActiveBlocksOverlappingMessages matches active block with overlapping effective message", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a", "msg-b"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-b"]))
    assert.equal(result.length, 1)
    assert.equal(result[0].blockId, 1)
})

test("findActiveBlocksOverlappingMessages skips inactive blocks", () => {
    const block = makeBlock({ blockId: 1, active: false, effectiveMessageIds: ["msg-a"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    assert.deepEqual(findActiveBlocksOverlappingMessages(ms, new Set(["msg-a"])), [])
})

test("findActiveBlocksOverlappingMessages handles partial overlap (matches whole block)", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a", "msg-b", "msg-c"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-b"]))
    assert.equal(result.length, 1)
    assert.equal(result[0].blockId, 1)
})

test("findActiveBlocksOverlappingMessages returns multiple matched blocks sorted by blockId", () => {
    const block3 = makeBlock({ blockId: 3, effectiveMessageIds: ["msg-c"] })
    const block1 = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a"] })
    const block2 = makeBlock({ blockId: 2, effectiveMessageIds: ["msg-b"] })
    const ms = makeMessagesState({
        blocksById: new Map([
            [3, block3],
            [1, block1],
            [2, block2],
        ]),
    })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-a", "msg-b", "msg-c"]))
    assert.deepEqual(result.map((b) => b.blockId), [1, 2, 3])
})

test("findActiveBlocksOverlappingMessages dedupes when block matches multiple messages in set", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a", "msg-b", "msg-c"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-a", "msg-b", "msg-c"]))
    assert.equal(result.length, 1)
})

test("findActiveBlocksOverlappingMessages returns no match when message IDs disjoint", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: ["msg-a", "msg-b"] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-x", "msg-y"]))
    assert.deepEqual(result, [])
})

test("findActiveBlocksOverlappingMessages treats undefined effectiveMessageIds as empty", () => {
    const block = makeBlock({ blockId: 1, effectiveMessageIds: undefined as unknown as string[] })
    const ms = makeMessagesState({ blocksById: new Map([[1, block]]) })
    assert.deepEqual(findActiveBlocksOverlappingMessages(ms, new Set(["msg-a"])), [])
})

test("findActiveBlocksOverlappingMessages handles nested blocks (child effective ⊇ ancestor)", () => {
    const ancestor = makeBlock({
        blockId: 1,
        effectiveMessageIds: ["msg-a", "msg-b"],
    })
    const child = makeBlock({
        blockId: 2,
        effectiveMessageIds: ["msg-a", "msg-b", "msg-c"],
        parentBlockIds: [1],
    })
    const ms = makeMessagesState({
        blocksById: new Map([
            [1, ancestor],
            [2, child],
        ]),
    })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-c"]))
    assert.deepEqual(result.map((b) => b.blockId), [2])
})

test("findActiveBlocksOverlappingMessages returns both ancestor and child when range covers ancestor messages", () => {
    const ancestor = makeBlock({
        blockId: 1,
        effectiveMessageIds: ["msg-a"],
    })
    const child = makeBlock({
        blockId: 2,
        effectiveMessageIds: ["msg-a", "msg-c"],
        parentBlockIds: [1],
    })
    const ms = makeMessagesState({
        blocksById: new Map([
            [1, ancestor],
            [2, child],
        ]),
    })
    const result = findActiveBlocksOverlappingMessages(ms, new Set(["msg-a"]))
    assert.deepEqual(result.map((b) => b.blockId), [1, 2])
})
