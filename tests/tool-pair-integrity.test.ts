import assert from "node:assert/strict"
import test from "node:test"
import { resolveBoundaryIds, resolveSelection } from "../lib/compress/search"
import type { SearchContext } from "../lib/compress/types"
import type { CompressionBlock, SessionState, WithParts } from "../lib/state/types"

const SID = "session-tool-pair-test"

let nextRawId = 1
function rawId(): string {
    return `raw-${nextRawId++}`
}

function makeMessage(opts: {
    id?: string
    role?: "user" | "assistant"
    parts?: any[]
}): WithParts {
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

function makeAssistantWithToolCall(id: string, callIDs: string[], text = "calling tool"): WithParts {
    const toolParts = callIDs.map((callID) => ({
        type: "tool",
        callID,
        tool: "read",
        state: { status: "pending" },
    }))
    return makeMessage({
        id,
        role: "assistant",
        parts: [{ type: "text", text }, ...toolParts],
    })
}

function makeUserWithToolResult(id: string, callID: string, text = "result"): WithParts {
    return makeMessage({
        id,
        role: "user",
        parts: [
            { type: "tool", callID, tool: "read", state: { status: "completed", output: text } },
        ],
    })
}

function makeAssistantText(id: string, text: string): WithParts {
    return makeMessage({ id, role: "assistant", parts: [{ type: "text", text }] })
}

function makeUserText(id: string, text: string): WithParts {
    return makeMessage({ id, role: "user", parts: [{ type: "text", text }] })
}

function makeState(messages: WithParts[]): SessionState {
    const state: SessionState = {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        prune: {
            messages: {
                byMessageId: new Map(),
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
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg) continue
        const ref = `m${String(i + 1).padStart(5, "0")}`
        state.messageIds.byRef.set(ref, msg.info.id)
        state.messageIds.byRawId.set(msg.info.id, ref)
    }

    return state
}

function makeContext(rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i]
        if (!msg) continue
        rawMessagesById.set(msg.info.id, msg)
        rawIndexById.set(msg.info.id, i)
    }
    return { rawMessages, rawMessagesById, rawIndexById, summaryByBlockId: new Map() }
}

// --- Tests ---

test("forward extension: tool_use at endIdx, tool_result at endIdx+1 → range extends forward", () => {
    const messages = [
        makeUserText("u1", "start task"),
        makeAssistantText("a1", "working"),
        makeAssistantWithToolCall("a2", ["call-abc"], "let me read"),
        makeUserWithToolResult("u2", "call-abc", "file content"),
        makeAssistantText("a3", "continuing"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00001–m00003 (u1, a1, a2)
    // a2 (m00003) has tool_use(call-abc), u2 (m00004) has tool_result(call-abc)
    // Without fix: u2 survives with orphaned reference
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")

    assert.equal(endReference.rawIndex, 3, "endIdx should extend to include tool_result at index 3")
    assert.equal(endReference.messageId, "u2", "endIdx messageId should be the tool_result message")
    assert.equal(startReference.rawIndex, 0, "startIdx unchanged")
})

test("backward extension: tool_result at startIdx, tool_use at startIdx-1 → range extends backward", () => {
    const messages = [
        makeUserText("u1", "start task"),
        makeAssistantWithToolCall("a1", ["call-xyz"], "calling read"),
        makeUserWithToolResult("u2", "call-xyz", "result"),
        makeAssistantText("a2", "processing"),
        makeAssistantText("a3", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00003–m00005 (u2, a2, a3)
    // u2 (m00003) has tool_result(call-xyz), a1 (m00002) has tool_use(call-xyz)
    // Without fix: a1 survives with orphaned tool_use
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00003", "m00005")

    assert.equal(startReference.rawIndex, 1, "startIdx should extend back to include tool_use at index 1")
    assert.equal(startReference.messageId, "a1", "startIdx messageId should be the tool_use message")
    assert.equal(endReference.rawIndex, 4, "endIdx unchanged")
})

test("no extension when both tool_use and tool_result are inside range", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantWithToolCall("a1", ["call-1"], "call"),
        makeUserWithToolResult("u2", "call-1", "result"),
        makeAssistantText("a2", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")

    assert.equal(startReference.rawIndex, 0, "startIdx unchanged — pair is inside range")
    assert.equal(endReference.rawIndex, 2, "endIdx unchanged — pair is inside range")
})

test("no extension when range has no tool calls", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantText("a1", "thinking"),
        makeAssistantText("a2", "more thinking"),
        makeUserText("u2", "next"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")

    assert.equal(startReference.rawIndex, 0)
    assert.equal(endReference.rawIndex, 2)
})

test("multiple tool results: one tool_use with multiple result messages → all included", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantText("a1", "thinking"),
        makeAssistantWithToolCall("a2", ["call-multi"], "batch call"),
        makeUserWithToolResult("u2", "call-multi", "result 1"),
        makeUserWithToolResult("u3", "call-multi", "result 2"),
        makeAssistantText("a3", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00001–m00003 (u1, a1, a2)
    // a2 has tool_use, u2 and u3 both have tool_result for same callID
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")

    assert.equal(endReference.rawIndex, 4, "endIdx extends to include both tool_result messages")
    assert.equal(endReference.messageId, "u3")
})

test("parallel tool calls: assistant with multiple tool_use, results in subsequent messages", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantWithToolCall("a1", ["call-a", "call-b"], "parallel calls"),
        makeUserWithToolResult("u2", "call-a", "result a"),
        makeUserWithToolResult("u3", "call-b", "result b"),
        makeAssistantText("a2", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00001–m00002 (u1, a1)
    // a1 has tool_use for call-a and call-b; u2 has call-a result, u3 has call-b result
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00002")

    assert.equal(endReference.rawIndex, 3, "endIdx extends to include both parallel tool results")
})

test("gap tolerance: non-tool message between tool_use and result still matched", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantWithToolCall("a1", ["call-gap"], "call"),
        makeAssistantText("a-gap", "some intermediate text"), // non-tool message
        makeUserWithToolResult("u2", "call-gap", "result"),
        makeAssistantText("a2", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00001–m00002 (u1, a1)
    // a1 has tool_use, m00003 is non-tool, u2 (m00004) has result
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00002")

    assert.equal(
        endReference.rawIndex,
        3,
        "endIdx extends past the gap to include the tool_result",
    )
})

test("adjustment flows through to resolveSelection: toolIds include paired messages", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantText("a1", "working"),
        makeAssistantWithToolCall("a2", ["call-flow"], "call"),
        makeUserWithToolResult("u2", "call-flow", "result"),
        makeAssistantText("a3", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")
    const selection = resolveSelection(ctx, startReference, endReference)

    assert.ok(selection.messageIds.includes("u2"), "tool_result message included in selection")
    assert.ok(selection.toolIds.includes("call-flow"), "callID included in toolIds")
    assert.equal(selection.messageIds.length, 4, "all 4 messages in range (u1, a1, a2, u2)")
})

test("backward extension changes startReference kind from block to message when needed", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantWithToolCall("a1", ["call-block"]),  // tool_use
        makeUserWithToolResult("u2", "call-block", "result"), // tool_result
        makeAssistantText("a2", "processing"),
        makeAssistantText("a3", "done"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses starting from m00003 (u2, the tool_result)
    // a1 (m00002) has the tool_use — must be included
    const { startReference } = resolveBoundaryIds(ctx, state, "m00003", "m00005")

    assert.equal(startReference.rawIndex, 1, "startIdx extended backward to tool_use")
    assert.equal(startReference.kind, "message", "kind is message after extension")
    assert.equal(startReference.messageId, "a1")
})

test("block boundary: kind preserved (compress tool calls excluded from scan)", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantText("a1", "working"),
        makeAssistantWithToolCall("a2", ["call-real"], "calling read"),
        makeUserWithToolResult("u2", "call-real", "result"),
        makeAssistantText("a3", "summarizing"),
        // Block b0 anchor at this compress call (m00006)
        makeMessage({
            id: "compress-a4",
            role: "assistant",
            parts: [{ type: "tool", callID: "call-compress-1", tool: "compress", state: { status: "pending" } }],
        }),
        // Compress result right after the anchor
        makeMessage({
            id: "compress-u3",
            role: "user",
            parts: [{ type: "tool", callID: "call-compress-1", tool: "compress", state: { status: "completed", output: "ok" } }],
        }),
        makeAssistantText("a5", "continuing"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Register block b0 at the compress call message
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 500,
        summaryTokens: 100,
        durationMs: 0,
        topic: "test",
        startId: "m00001",
        endId: "m00004",
        anchorMessageId: "compress-a4",
        compressMessageId: "compress-a4",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["u1", "a1", "a2", "u2"],
        directToolIds: ["call-real"],
        effectiveMessageIds: ["u1", "a1", "a2", "u2"],
        effectiveToolIds: ["call-real"],
        createdAt: 1000,
        summary: "compressed",
        survivedCount: 0,
        tier: 1,
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("compress-a4", 1)
    ctx.summaryByBlockId.set(1, block)

    // Model compresses b1 → b1 (T2 distillation)
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "b1", "b1")

    // compress callID should NOT trigger extension
    assert.equal(startReference.kind, "compressed-block", "startReference kind preserved for block boundary")
    assert.equal(endReference.kind, "compressed-block", "endReference kind preserved for block boundary")
    assert.equal(startReference.rawIndex, endReference.rawIndex, "block maps to single anchor index")
})

test("compress tool excluded: message boundary with compress calls does not extend", () => {
    const messages = [
        makeUserText("u1", "start"),
        makeAssistantText("a1", "working"),
        // Compress tool_use (force-protected — should NOT trigger extension)
        makeMessage({
            id: "a2-compress",
            role: "assistant",
            parts: [{ type: "tool", callID: "call-c1", tool: "compress", state: { status: "pending" } }],
        }),
        // Compress result right after — would match if compress wasn't excluded
        makeMessage({
            id: "u2-compress-result",
            role: "user",
            parts: [{ type: "tool", callID: "call-c1", tool: "compress", state: { status: "completed", output: "done" } }],
        }),
        makeAssistantText("a3", "continuing"),
    ]

    const ctx = makeContext(messages)
    const state = makeState(messages)

    // Model compresses m00001–m00003 (u1, a1, a2-compress)
    // a2-compress has compress tool_use(call-c1), u2-compress-result has result
    // Without the compress exclusion: endIdx would extend to 3 (the result)
    // With exclusion: compress callID is skipped → no extension
    const { startReference, endReference } = resolveBoundaryIds(ctx, state, "m00001", "m00003")

    assert.equal(endReference.rawIndex, 2, "endIdx unchanged — compress tool excluded from scan")
    assert.equal(startReference.rawIndex, 0, "startIdx unchanged")
})
