import assert from "node:assert/strict"
import test from "node:test"
import {
    buildSearchContext,
    resolveBoundaryIds,
    resolveSelection,
    resolveAnchorMessageId,
} from "../lib/compress/search"
import type { BoundaryReference, SearchContext } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState, WithParts } from "../lib/state/types"

// --- Factory helpers ---

const SID = "session-search-test"

let nextRawId = 1
function rawId(): string {
    return `raw-${nextRawId++}`
}

interface MockMessageOptions {
    id?: string
    role?: "user" | "assistant"
    parts?: any[]
}

function makeMessage(opts: MockMessageOptions = {}): WithParts {
    const id = opts.id ?? rawId()
    const role = opts.role ?? "assistant"
    return {
        info: {
            id,
            sessionID: SID,
            role,
            time: { created: 1000 },
            ...(role === "assistant"
                ? {
                      parentID: "parent-1",
                      modelID: "test-model",
                      providerID: "test-provider",
                      mode: "normal",
                      agent: "test",
                      path: { cwd: "/", root: "/" },
                      summary: false,
                      cost: 0,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  }
                : {
                      agent: "test",
                      model: { providerID: "test-provider", modelID: "test-model" },
                  }),
        } as any,
        parts: opts.parts ?? [{ type: "text", text: "hello" }],
    }
}

function makeUserMessage(id: string, text: string, ignored = false): WithParts {
    return makeMessage({
        id,
        role: "user",
        parts: [{ type: "text", text, ignored, id: `part-${id}`, sessionID: SID, messageID: id }],
    })
}

function makeAssistantMessage(id: string, text: string, extraParts: any[] = []): WithParts {
    return makeMessage({
        id,
        role: "assistant",
        parts: [{ type: "text", text }, ...extraParts],
    })
}

function makeToolPart(callID: string): any {
    return { type: "tool", callID, tool: "read", state: { status: "completed" } }
}

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
        anchorMessageId: "raw-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A summary",
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

function makeContext(rawMessages: WithParts[], blocks: Map<number, CompressionBlock> = new Map()): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i]
        if (!msg) continue
        rawMessagesById.set(msg.info.id, msg)
        rawIndexById.set(msg.info.id, i)
    }
    const summaryByBlockId = new Map<number, CompressionBlock>()
    for (const [blockId, block] of blocks) {
        if (!block.active) continue
        summaryByBlockId.set(blockId, block)
    }
    return { rawMessages, rawMessagesById, rawIndexById, summaryByBlockId }
}

// --- Tests for buildSearchContext ---

test("buildSearchContext with empty messages returns empty maps", () => {
    const state = makeState()
    const ctx = buildSearchContext(state, [])
    assert.equal(ctx.rawMessages.length, 0)
    assert.equal(ctx.rawMessagesById.size, 0)
    assert.equal(ctx.rawIndexById.size, 0)
    assert.equal(ctx.summaryByBlockId.size, 0)
})

test("buildSearchContext indexes messages by id and position", () => {
    const state = makeState()
    const msg1 = makeAssistantMessage("alpha", "first")
    const msg2 = makeAssistantMessage("beta", "second")
    const ctx = buildSearchContext(state, [msg1, msg2])

    assert.equal(ctx.rawMessagesById.get("alpha"), msg1)
    assert.equal(ctx.rawMessagesById.get("beta"), msg2)
    assert.equal(ctx.rawIndexById.get("alpha"), 0)
    assert.equal(ctx.rawIndexById.get("beta"), 1)
})

test("buildSearchContext includes active blocks in summaryByBlockId", () => {
    const block = makeBlock({ blockId: 5, anchorMessageId: "anchor-5", summary: "block summary" })
    const state = makeState()
    state.prune.messages.blocksById.set(5, block)

    const ctx = buildSearchContext(state, [])
    assert.equal(ctx.summaryByBlockId.size, 1)
    assert.equal(ctx.summaryByBlockId.get(5)?.summary, "block summary")
})

test("buildSearchContext excludes inactive blocks from summaryByBlockId", () => {
    const activeBlock = makeBlock({ blockId: 1, active: true })
    const inactiveBlock = makeBlock({ blockId: 2, active: false })
    const state = makeState()
    state.prune.messages.blocksById.set(1, activeBlock)
    state.prune.messages.blocksById.set(2, inactiveBlock)

    const ctx = buildSearchContext(state, [])
    assert.equal(ctx.summaryByBlockId.size, 1)
    assert.ok(ctx.summaryByBlockId.has(1))
    assert.ok(!ctx.summaryByBlockId.has(2))
})

test("buildSearchContext with multiple active blocks includes all", () => {
    const b1 = makeBlock({ blockId: 1 })
    const b2 = makeBlock({ blockId: 2 })
    const state = makeState()
    state.prune.messages.blocksById.set(1, b1)
    state.prune.messages.blocksById.set(2, b2)

    const ctx = buildSearchContext(state, [])
    assert.equal(ctx.summaryByBlockId.size, 2)
})

// --- Tests for resolveBoundaryIds ---

test("resolveBoundaryIds resolves message IDs correctly", () => {
    const msg1 = makeAssistantMessage("raw-a", "first")
    const msg2 = makeAssistantMessage("raw-b", "second")
    const ctx = makeContext([msg1, msg2])

    const state = makeState()
    state.messageIds.byRef.set("m00001", "raw-a")
    state.messageIds.byRef.set("m00002", "raw-b")
    state.messageIds.byRawId.set("raw-a", "m00001")
    state.messageIds.byRawId.set("raw-b", "m00002")

    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00002")
    assert.equal(startReference.kind, "message")
    assert.equal(startReference.messageId, "raw-a")
    assert.equal(startReference.rawIndex, 0)
    assert.equal(endReference.kind, "message")
    assert.equal(endReference.messageId, "raw-b")
    assert.equal(endReference.rawIndex, 1)
})

test("resolveBoundaryIds resolves block IDs correctly", () => {
    const msg = makeAssistantMessage("anchor-1", "anchor content")
    const block = makeBlock({ blockId: 3, anchorMessageId: "anchor-1" })
    const blocks = new Map([[3, block]])
    const ctx = makeContext([msg], blocks)

    const state = makeState()
    state.prune.messages.blocksById.set(3, block)

    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "b3", "b3")
    assert.equal(startReference.kind, "compressed-block")
    assert.equal(startReference.blockId, 3)
    assert.equal(startReference.anchorMessageId, "anchor-1")
    assert.equal(startReference.rawIndex, 0)
})

test("resolveBoundaryIds throws on invalid startId format", () => {
    const ctx = makeContext([])
    const state = makeState()
    assert.throws(
        () => resolveBoundaryIds(ctx, state, "invalid", "m00001"),
        /startId is invalid/,
    )
})

test("resolveBoundaryIds throws on unknown message ref", () => {
    const ctx = makeContext([])
    const state = makeState()
    assert.throws(
        () => resolveBoundaryIds(ctx, state, "m00099", "m00100"),
        /not available/,
    )
})

test("resolveBoundaryIds auto-swaps reversed boundaries (Bug 34)", () => {
    const msg1 = makeAssistantMessage("raw-a", "first")
    const msg2 = makeAssistantMessage("raw-b", "second")
    const ctx = makeContext([msg1, msg2])

    const state = makeState()
    state.messageIds.byRef.set("m00001", "raw-a")
    state.messageIds.byRef.set("m00002", "raw-b")
    state.messageIds.byRawId.set("raw-a", "m00001")
    state.messageIds.byRawId.set("raw-b", "m00002")

    // Pass in reversed order: end before start
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00002", "m00001")
    assert.equal(startReference.messageId, "raw-a")
    assert.equal(startReference.rawIndex, 0)
    assert.equal(endReference.messageId, "raw-b")
    assert.equal(endReference.rawIndex, 1)
})

test("resolveBoundaryIds auto-swaps reversed block refs", () => {
    const msg1 = makeAssistantMessage("anchor-1", "earlier")
    const msg2 = makeAssistantMessage("anchor-2", "later")
    const block1 = makeBlock({ blockId: 1, anchorMessageId: "anchor-1" })
    const block2 = makeBlock({ blockId: 2, anchorMessageId: "anchor-2" })
    const blocks = new Map([
        [1, block1],
        [2, block2],
    ])
    const ctx = makeContext([msg1, msg2], blocks)

    const state = makeState()
    state.prune.messages.blocksById.set(1, block1)
    state.prune.messages.blocksById.set(2, block2)

    // Pass reversed: b2 (at index 1) before b1 (at index 0)
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "b2", "b1")
    assert.equal(startReference.blockId, 1)
    assert.equal(startReference.rawIndex, 0)
    assert.equal(endReference.blockId, 2)
    assert.equal(endReference.rawIndex, 1)
})

// --- Tests for resolveSelection ---

test("resolveSelection collects message IDs in range", () => {
    const msg1 = makeAssistantMessage("a", "first")
    const msg2 = makeAssistantMessage("b", "second")
    const msg3 = makeAssistantMessage("c", "third")
    const ctx = makeContext([msg1, msg2, msg3])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 2, messageId: "c" }

    const result = resolveSelection(ctx, startRef, endRef)
    assert.deepEqual(result.messageIds, ["a", "b", "c"])
    assert.equal(result.toolIds.length, 0)
})

test("resolveSelection includes tool invocations between messages", () => {
    const msg1 = makeAssistantMessage("a", "first")
    const msg2 = makeAssistantMessage("b", "second", [makeToolPart("tool-call-1")])
    const msg3 = makeAssistantMessage("c", "third")
    const ctx = makeContext([msg1, msg2, msg3])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 2, messageId: "c" }

    const result = resolveSelection(ctx, startRef, endRef)
    assert.deepEqual(result.messageIds, ["a", "b", "c"])
    assert.deepEqual(result.toolIds, ["tool-call-1"])
})

test("resolveSelection deduplicates tool IDs across messages", () => {
    const msg1 = makeAssistantMessage("a", "first", [makeToolPart("tool-1")])
    const msg2 = makeAssistantMessage("b", "second", [makeToolPart("tool-1")])
    const ctx = makeContext([msg1, msg2])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 1, messageId: "b" }

    const result = resolveSelection(ctx, startRef, endRef)
    assert.deepEqual(result.toolIds, ["tool-1"])
})

test("resolveSelection skips ignored user messages", () => {
    const msg1 = makeAssistantMessage("a", "first")
    const msg2 = makeUserMessage("b", "ignored", true) // ignored user msg
    const msg3 = makeAssistantMessage("c", "third")
    const ctx = makeContext([msg1, msg2, msg3])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 2, messageId: "c" }

    const result = resolveSelection(ctx, startRef, endRef)
    // "b" is an ignored user message, so it should be skipped
    assert.deepEqual(result.messageIds, ["a", "c"])
})

test("resolveSelection includes required block IDs for anchors in range", () => {
    const msg1 = makeAssistantMessage("a", "first")
    const msg2 = makeAssistantMessage("b", "second")
    const block1 = makeBlock({ blockId: 1, anchorMessageId: "a" })
    const block2 = makeBlock({ blockId: 2, anchorMessageId: "b" })
    const blocks = new Map([
        [1, block1],
        [2, block2],
    ])
    const ctx = makeContext([msg1, msg2], blocks)

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 1, messageId: "b" }

    const result = resolveSelection(ctx, startRef, endRef)
    assert.deepEqual(result.requiredBlockIds, [1, 2])
})

test("resolveSelection throws on empty selection", () => {
    // Create context with only ignored user messages
    const msg1 = makeUserMessage("a", "ignored", true)
    const ctx = makeContext([msg1])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }

    assert.throws(
        () => resolveSelection(ctx, startRef, endRef),
        /Failed to map boundary matches/,
    )
})

test("resolveSelection includes messageTokenById for selected messages", () => {
    const msg1 = makeAssistantMessage("a", "hello world")
    const ctx = makeContext([msg1])

    const startRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }
    const endRef: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "a" }

    const result = resolveSelection(ctx, startRef, endRef)
    assert.ok(result.messageTokenById.has("a"))
    assert.ok(result.messageTokenById.get("a")! > 0)
})

// --- Tests for resolveAnchorMessageId ---

test("resolveAnchorMessageId returns messageId for message kind", () => {
    const ref: BoundaryReference = { kind: "message", rawIndex: 0, messageId: "msg-42" }
    assert.equal(resolveAnchorMessageId(ref), "msg-42")
})

test("resolveAnchorMessageId returns anchorMessageId for compressed-block kind", () => {
    const ref: BoundaryReference = {
        kind: "compressed-block",
        rawIndex: 5,
        blockId: 3,
        anchorMessageId: "anchor-xyz",
    }
    assert.equal(resolveAnchorMessageId(ref), "anchor-xyz")
})

test("resolveAnchorMessageId throws for compressed-block without anchorMessageId", () => {
    const ref: BoundaryReference = { kind: "compressed-block", rawIndex: 5, blockId: 3 }
    assert.throws(
        () => resolveAnchorMessageId(ref),
        /Failed to map boundary matches/,
    )
})

test("resolveAnchorMessageId throws for message kind without messageId", () => {
    const ref: BoundaryReference = { kind: "message", rawIndex: 0 }
    assert.throws(
        () => resolveAnchorMessageId(ref),
        /Failed to map boundary matches/,
    )
})
