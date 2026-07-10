import assert from "node:assert/strict"
import test from "node:test"
import {
    formatMessageRef,
    formatBlockRef,
    parseMessageRef,
    parseBlockRef,
    parseBoundaryId,
    assignMessageRefs,
    formatMessageIdTag,
    formatTokenSize,
    classifyMessageType,
} from "../lib/message-ids"
import type { PrunedMessageEntry, SessionState, WithParts } from "../lib/state/types"

// --- Factory helpers ---

const SID = "session-msgids-test"

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

// --- Tests for formatMessageRef ---

test("formatMessageRef formats index 1 as m00001", () => {
    assert.equal(formatMessageRef(1), "m00001")
})

test("formatMessageRef formats index 9999 as m09999", () => {
    assert.equal(formatMessageRef(9999), "m09999")
})

test("formatMessageRef formats index 123 as m00123", () => {
    assert.equal(formatMessageRef(123), "m00123")
})

test("formatMessageRef formats index 99999 as m99999", () => {
    assert.equal(formatMessageRef(99999), "m99999")
})

test("formatMessageRef throws for index 0", () => {
    assert.throws(() => formatMessageRef(0), /out of bounds/)
})

test("formatMessageRef throws for negative index", () => {
    assert.throws(() => formatMessageRef(-1), /out of bounds/)
})

test("formatMessageRef throws for index exceeding 99999", () => {
    assert.throws(() => formatMessageRef(100000), /out of bounds/)
})

test("formatMessageRef throws for non-integer", () => {
    assert.throws(() => formatMessageRef(1.5), /out of bounds/)
})

// --- Tests for formatBlockRef ---

test("formatBlockRef formats block ID 1 as b1", () => {
    assert.equal(formatBlockRef(1), "b1")
})

test("formatBlockRef formats block ID 42 as b42", () => {
    assert.equal(formatBlockRef(42), "b42")
})

test("formatBlockRef throws for 0", () => {
    assert.throws(() => formatBlockRef(0), /Invalid block ID/)
})

test("formatBlockRef throws for negative", () => {
    assert.throws(() => formatBlockRef(-1), /Invalid block ID/)
})

// --- Tests for parseMessageRef ---

test("parseMessageRef parses m0001 (4-digit) to index 1", () => {
    assert.equal(parseMessageRef("m0001"), 1)
})

test("parseMessageRef parses m00001 (5-digit) to index 1", () => {
    assert.equal(parseMessageRef("m00001"), 1)
})

test("parseMessageRef parses m9999 (4-digit) to index 9999", () => {
    assert.equal(parseMessageRef("m9999"), 9999)
})

test("parseMessageRef parses m99999 to index 99999", () => {
    assert.equal(parseMessageRef("m99999"), 99999)
})

test("parseMessageRef is case-insensitive", () => {
    assert.equal(parseMessageRef("M00001"), 1)
})

test("parseMessageRef trims whitespace", () => {
    assert.equal(parseMessageRef("  m00001  "), 1)
})

test("parseMessageRef returns null for invalid format", () => {
    assert.equal(parseMessageRef("m0"), null)
    assert.equal(parseMessageRef("m100000"), null)
    assert.equal(parseMessageRef("abc"), null)
    assert.equal(parseMessageRef(""), null)
})

test("parseMessageRef returns null for wrong digit count", () => {
    assert.equal(parseMessageRef("m001"), null)
    assert.equal(parseMessageRef("m0000001"), null)
})

// --- Tests for parseBlockRef ---

test("parseBlockRef parses b1 to 1", () => {
    assert.equal(parseBlockRef("b1"), 1)
})

test("parseBlockRef parses b99 to 99", () => {
    assert.equal(parseBlockRef("b99"), 99)
})

test("parseBlockRef is case-insensitive", () => {
    assert.equal(parseBlockRef("B5"), 5)
})

test("parseBlockRef trims whitespace", () => {
    assert.equal(parseBlockRef("  b3  "), 3)
})

test("parseBlockRef returns null for b0", () => {
    assert.equal(parseBlockRef("b0"), null)
})

test("parseBlockRef returns null for invalid format", () => {
    assert.equal(parseBlockRef("b"), null)
    assert.equal(parseBlockRef("b01"), null)
    assert.equal(parseBlockRef("abc"), null)
})

// --- Tests for parseBoundaryId ---

test("parseBoundaryId parses message ref to message kind", () => {
    const result = parseBoundaryId("m00005")
    assert.ok(result)
    assert.equal(result!.kind, "message")
    if (result!.kind === "message") {
        assert.equal(result!.index, 5)
        assert.equal(result!.ref, "m00005")
    }
})

test("parseBoundaryId parses block ref to compressed-block kind", () => {
    const result = parseBoundaryId("b7")
    assert.ok(result)
    assert.equal(result!.kind, "compressed-block")
    if (result!.kind === "compressed-block") {
        assert.equal(result!.blockId, 7)
        assert.equal(result!.ref, "b7")
    }
})

test("parseBoundaryId returns null for unrecognized input", () => {
    assert.equal(parseBoundaryId("x123"), null)
    assert.equal(parseBoundaryId(""), null)
    assert.equal(parseBoundaryId("m0"), null)
})

// --- Tests for assignMessageRefs ---

test("assignMessageRefs assigns sequential mNNNNN IDs to new messages", () => {
    const state = makeState()
    const msg1 = makeMessage({ id: "raw-a" })
    const msg2 = makeMessage({ id: "raw-b" })
    const msg3 = makeMessage({ id: "raw-c" })

    const count = assignMessageRefs(state, [msg1, msg2, msg3])

    assert.equal(count, 3)
    assert.equal(state.messageIds.byRawId.get("raw-a"), "m00001")
    assert.equal(state.messageIds.byRawId.get("raw-b"), "m00002")
    assert.equal(state.messageIds.byRawId.get("raw-c"), "m00003")
    assert.equal(state.messageIds.byRef.get("m00001"), "raw-a")
    assert.equal(state.messageIds.byRef.get("m00002"), "raw-b")
    assert.equal(state.messageIds.byRef.get("m00003"), "raw-c")
})

test("assignMessageRefs preserves existing IDs on second call", () => {
    const state = makeState()
    const msg1 = makeMessage({ id: "raw-a" })

    assignMessageRefs(state, [msg1])
    assert.equal(state.messageIds.byRawId.get("raw-a"), "m00001")

    const msg2 = makeMessage({ id: "raw-b" })
    const count = assignMessageRefs(state, [msg1, msg2])

    assert.equal(count, 1)
    assert.equal(state.messageIds.byRawId.get("raw-a"), "m00001")
    assert.equal(state.messageIds.byRawId.get("raw-b"), "m00002")
})

test("assignMessageRefs skips messages with empty or missing IDs", () => {
    const state = makeState()
    const msg1 = makeMessage({ id: "" })
    const msg2 = makeMessage({ id: "raw-good" })
    const msg1Original = { ...msg1, info: { ...msg1.info, id: undefined } }

    const count = assignMessageRefs(state, [msg1Original, msg2])

    assert.equal(count, 1)
    assert.equal(state.messageIds.byRawId.get("raw-good"), "m00001")
})

test("assignMessageRefs skips DCP synthetic message IDs", () => {
    const state = makeState()
    const msg1 = makeMessage({ id: "msg_dcp_summary_123" })
    const msg2 = makeMessage({ id: "msg_dcp_text_456" })
    const msg3 = makeMessage({ id: "raw-normal" })

    const count = assignMessageRefs(state, [msg1, msg2, msg3])

    assert.equal(count, 1)
    assert.equal(state.messageIds.byRawId.get("raw-normal"), "m00001")
    assert.ok(!state.messageIds.byRawId.has("msg_dcp_summary_123"))
    assert.ok(!state.messageIds.byRawId.has("msg_dcp_text_456"))
})

test("assignMessageRefs skips ignored user messages", () => {
    const state = makeState()
    const ignoredUser = makeMessage({
        id: "ignored-user",
        role: "user",
        parts: [{ type: "text", text: "ignored", ignored: true }],
    })
    const normalMsg = makeMessage({ id: "raw-normal" })

    const count = assignMessageRefs(state, [ignoredUser, normalMsg])

    assert.equal(count, 1)
    assert.ok(!state.messageIds.byRawId.has("ignored-user"))
    assert.equal(state.messageIds.byRawId.get("raw-normal"), "m00001")
})

test("assignMessageRefs handles gap in nextRef by scanning for free slot", () => {
    const state = makeState()
    state.messageIds.nextRef = 1
    state.messageIds.byRef.set("m00001", "already-used")
    state.messageIds.byRawId.set("already-used", "m00001")

    const msg = makeMessage({ id: "raw-new" })
    const count = assignMessageRefs(state, [msg])

    assert.equal(count, 1)
    assert.equal(state.messageIds.byRawId.get("raw-new"), "m00002")
})

test("assignMessageRefs skips first user message in sub-agent mode", () => {
    const state = makeState({ isSubAgent: true })
    const subAgentPrompt = makeMessage({ id: "sub-prompt", role: "user" })
    const assistantMsg = makeMessage({ id: "raw-asst", role: "assistant" })
    const laterUserMsg = makeMessage({ id: "raw-user2", role: "user" })

    const count = assignMessageRefs(state, [subAgentPrompt, assistantMsg, laterUserMsg])

    assert.equal(count, 2)
    assert.ok(!state.messageIds.byRawId.has("sub-prompt"))
    assert.equal(state.messageIds.byRawId.get("raw-asst"), "m00001")
    assert.equal(state.messageIds.byRawId.get("raw-user2"), "m00002")
})

test("assignMessageRefs returns 0 for empty message array", () => {
    const state = makeState()
    assert.equal(assignMessageRefs(state, []), 0)
})

// --- Backward compatibility: 4-digit → 5-digit ref migration ---

test("parseBoundaryId normalizes 4-digit ref to 5-digit", () => {
    const result = parseBoundaryId("m0001")
    assert.ok(result !== null)
    assert.equal(result.kind, "message")
    assert.equal(result.ref, "m00001")
    assert.equal(result.index, 1)
})

test("parseBoundaryId normalizes 4-digit ref m9999 to 5-digit m09999", () => {
    const result = parseBoundaryId("m9999")
    assert.ok(result !== null)
    assert.equal(result.kind, "message")
    assert.equal(result.ref, "m09999")
    assert.equal(result.index, 9999)
})

test("4-digit to 5-digit migration roundtrip: parseMessageRef then formatMessageRef", () => {
    // This is the exact pattern used in state.ts ensureSessionInitialized
    const oldRef = "m0001"
    const parsed = parseMessageRef(oldRef)
    assert.equal(parsed, 1)
    const newRef = formatMessageRef(parsed!)
    assert.equal(newRef, "m00001")
    assert.notEqual(newRef, oldRef) // Confirms migration needed
})

test("5-digit refs are unchanged by roundtrip", () => {
    const ref = "m00001"
    const parsed = parseMessageRef(ref)
    const normalized = formatMessageRef(parsed!)
    assert.equal(normalized, ref)
})

// =====================================================================
// formatTokenSize
// =====================================================================

test("formatTokenSize formats small counts as exact numbers", () => {
    assert.equal(formatTokenSize(0), "0")
    assert.equal(formatTokenSize(500), "500")
    assert.equal(formatTokenSize(999), "999")
})

test("formatTokenSize formats thousands with one decimal", () => {
    assert.equal(formatTokenSize(1000), "1.0K")
    assert.equal(formatTokenSize(2100), "2.1K")
    assert.equal(formatTokenSize(9999), "10.0K")
})

test("formatTokenSize formats large thousands rounded", () => {
    assert.equal(formatTokenSize(10000), "10K")
    assert.equal(formatTokenSize(20700), "21K")
    assert.equal(formatTokenSize(100000), "100K")
})

// =====================================================================
// classifyMessageType
// =====================================================================

test("classifyMessageType returns 'text' for text-only parts", () => {
    assert.equal(classifyMessageType([{ type: "text", text: "hello" }]), "text")
})

test("classifyMessageType returns 'tool:<name>' for tool parts", () => {
    assert.equal(
        classifyMessageType([{ type: "tool", tool: "bash", state: { status: "completed" } }]),
        "tool:bash",
    )
})

test("classifyMessageType returns 'tool' for tool parts without name", () => {
    assert.equal(classifyMessageType([{ type: "tool", state: { status: "completed" } }]), "tool")
})

test("classifyMessageType returns multiple tool names comma-separated", () => {
    assert.equal(
        classifyMessageType([
            { type: "tool", tool: "bash", state: { status: "completed" } },
            { type: "tool", tool: "read", state: { status: "completed" } },
        ]),
        "tool:bash,read",
    )
})

test("classifyMessageType returns 'reasoning' for reasoning-only parts", () => {
    assert.equal(classifyMessageType([{ type: "reasoning", text: "thinking..." }]), "reasoning")
})

// =====================================================================
// formatMessageIdTag with token/type attributes
// =====================================================================

test("formatMessageIdTag includes tokens and type attributes", () => {
    const tag = formatMessageIdTag("m00175", { tokens: "20.7K", type: "tool:bash" })
    assert.ok(tag.includes('tokens="20.7K"'), "tag should contain tokens attribute")
    assert.ok(tag.includes('type="tool:bash"'), "tag should contain type attribute")
    assert.ok(tag.includes(">m00175<"), "tag should contain the ref")
})

test("formatMessageIdTag omits empty/undefined attributes", () => {
    const tag = formatMessageIdTag("m00001", { tokens: undefined, type: "", priority: "low" })
    assert.ok(!tag.includes("tokens="), "should omit undefined tokens")
    assert.ok(!tag.includes("type="), "should omit empty type")
    assert.ok(tag.includes('priority="low"'), "should include priority")
})
