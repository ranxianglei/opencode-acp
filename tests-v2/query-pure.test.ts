import assert from "node:assert/strict"
import test from "node:test"
import { messageHasCompress, isIgnoredUserMessage } from "../lib-v2/messages/query"

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
