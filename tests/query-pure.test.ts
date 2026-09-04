import assert from "node:assert/strict"
import test from "node:test"
import { messageHasCompress, isIgnoredUserMessage, isCaptureOnlyCompress } from "../lib/messages/query"

function makeAssistant(overrides: Record<string, any> = {}) {
    return {
        info: {
            id: "msg-1",
            sessionID: "sess-1",
            role: "assistant",
            time: { created: 1234567890 },
            ...overrides,
        },
        parts: [],
        ...overrides,
    }
}

function makeUser(parts: any[] = [], overrides: Record<string, any> = {}) {
    return {
        info: {
            id: "msg-u1",
            sessionID: "sess-1",
            role: "user",
            time: { created: 1234567890 },
            ...overrides,
        },
        parts,
        ...overrides,
    }
}

test("messageHasCompress returns true for assistant message with completed compress tool", () => {
    const msg = makeAssistant()
    msg.parts = [{ type: "tool", tool: "compress", state: { status: "completed" } }]
    assert.equal(messageHasCompress(msg as any), true)
})

test("messageHasCompress returns false for message with non-compress tool", () => {
    const msg = makeAssistant()
    msg.parts = [{ type: "tool", tool: "read", state: { status: "completed" } }]
    assert.equal(messageHasCompress(msg as any), false)
})

test("messageHasCompress returns false for compress tool with non-completed status", () => {
    const msg = makeAssistant()
    msg.parts = [{ type: "tool", tool: "compress", state: { status: "running" } }]
    assert.equal(messageHasCompress(msg as any), false)
})

test("messageHasCompress returns false for compress tool with no state", () => {
    const msg = makeAssistant()
    msg.parts = [{ type: "tool", tool: "compress" }]
    assert.equal(messageHasCompress(msg as any), false)
})

test("messageHasCompress returns false for user message", () => {
    const msg = makeUser()
    msg.parts = [{ type: "tool", tool: "compress", state: { status: "completed" } }]
    assert.equal(messageHasCompress(msg as any), false)
})

test("messageHasCompress returns false for message with no parts", () => {
    const msg = makeAssistant()
    msg.parts = []
    assert.equal(messageHasCompress(msg as any), false)
})

test("isIgnoredUserMessage returns true for user message with no parts", () => {
    const msg = makeUser([])
    assert.equal(isIgnoredUserMessage(msg as any), true)
})

test("isIgnoredUserMessage returns true for user message with all parts ignored", () => {
    const msg = makeUser([{ type: "text", text: "hi", ignored: true }, { type: "text", text: "bye", ignored: true }])
    assert.equal(isIgnoredUserMessage(msg as any), true)
})

test("isIgnoredUserMessage returns false for user message with non-ignored parts", () => {
    const msg = makeUser([{ type: "text", text: "hi", ignored: true }, { type: "text", text: "real" }])
    assert.equal(isIgnoredUserMessage(msg as any), false)
})

test("isIgnoredUserMessage returns false for user message where first part is not ignored", () => {
    const msg = makeUser([{ type: "text", text: "real" }])
    assert.equal(isIgnoredUserMessage(msg as any), false)
})

test("isIgnoredUserMessage returns false for assistant message", () => {
    const msg = makeAssistant()
    assert.equal(isIgnoredUserMessage(msg as any), false)
})

test("isIgnoredUserMessage returns false for message with undefined parts field", () => {
    const msg = makeUser()
    ;(msg as any).parts = undefined
    assert.equal(isIgnoredUserMessage(msg as any), false)
})

test("isCaptureOnlyCompress returns true for m-prefix boundaries (raw-message T1 capture)", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: { input: { content: [{ startId: "m00001", endId: "m00010", summary: "x" }] } },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), true)
})

test("isCaptureOnlyCompress returns true for multiple m-prefix entries", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: { input: { content: [{ startId: "m00001" }, { startId: "m00020", endId: "m00030" }] } },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), true)
})

test("isCaptureOnlyCompress returns false when any boundary is a block ref (T2/T3 distillation)", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: { input: { content: [{ startId: "b3", endId: "b15", summary: "x" }] } },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), false)
})

test("isCaptureOnlyCompress returns false for mixed m-prefix and block-ref boundaries", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: {
             input: {
                 content: [{ startId: "m00001", endId: "m00005" }, { startId: "B7", endId: "b9" }],
            } },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), false, "uppercase B-prefix also matches /^b\\d+$/i")
})

test("isCaptureOnlyCompress returns false for unparsable input (conservative: keep reset)", () => {
    const msg = makeAssistant()
    msg.parts = [
        { type: "tool", tool: "compress", state: { input: {} } },
        { type: "tool", tool: "compress", state: {} },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), false, "no parsable boundaries → conservative false")
})

test("isCaptureOnlyCompress returns true for JSON-string input with m-prefix boundary", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: { input: '{"content":[{"startId":"m00001","endId":"m00012"}]}' },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), true, "string input is parsed")
})

test("isCaptureOnlyCompress returns false for malformed JSON-string input", () => {
    const msg = makeAssistant()
    msg.parts = [
        { type: "tool", tool: "compress", state: { input: "{not json" } },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), false, "JSON.parse failure → empty ids → conservative false")
})

test("isCaptureOnlyCompress returns false when boundaries are empty/whitespace strings", () => {
    const msg = makeAssistant()
    msg.parts = [
        {
            type: "tool",
            tool: "compress",
            state: { input: { content: [{ startId: " ", endId: "" }] } },
        },
    ]
    assert.equal(isCaptureOnlyCompress(msg as any), false, "no usable boundary → conservative false")
})

test("isCaptureOnlyCompress returns false for a user message", () => {
    const msg = makeUser([{ type: "text", text: "hi" }])
    ;(msg as any).parts.push({ type: "tool", tool: "compress", state: { input: { content: [{ startId: "m00001" }] } } })
    assert.equal(isCaptureOnlyCompress(msg as any), false)
})

test("isCaptureOnlyCompress returns false for non-compress tool parts", () => {
    const msg = makeAssistant()
    msg.parts = [{ type: "tool", tool: "read", state: { input: { content: [{ startId: "m00001" }] } } }]
    assert.equal(isCaptureOnlyCompress(msg as any), false)
})

test("isCaptureOnlyCompress returns false for undefined message", () => {
    assert.equal(isCaptureOnlyCompress(undefined), false)
})
