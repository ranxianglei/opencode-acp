import assert from "node:assert/strict"
import test from "node:test"
import { dropEmptyUserMessages } from "../lib/messages/utils"
import type { WithParts } from "../lib/state"

const sessionID = "ses_drop_empty"

function buildUserMessage(parts: WithParts["parts"], id = "msg-user"): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

function buildAssistantMessage(parts: WithParts["parts"], id = "msg-assistant"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

test("removes user message with no parts", () => {
    const messages = [buildUserMessage([])]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("removes user message with empty text part", () => {
    const messages = [buildUserMessage([{ type: "text", text: "" }])]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("removes user message with whitespace-only text", () => {
    const messages = [buildUserMessage([{ type: "text", text: "   \n\t  " }])]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("preserves user message with text content", () => {
    const msg = buildUserMessage([{ type: "text", text: "hello world" }])
    const messages = [msg]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0], msg)
})

test("preserves user message with completed tool output", () => {
    const msg = buildUserMessage([
        {
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "result" },
        },
    ])
    const messages = [msg]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
})

test("removes empty user message but keeps completed tool message", () => {
    const emptyUser = buildUserMessage([{ type: "text", text: "" }], "msg-empty")
    const toolUser = buildUserMessage(
        [{ type: "tool", tool: "bash", state: { status: "completed", output: "data" } }],
        "msg-tool",
    )
    const messages = [emptyUser, toolUser]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-tool")
})

test("does NOT remove empty assistant messages", () => {
    const messages = [buildAssistantMessage([]), buildAssistantMessage([{ type: "text", text: "" }])]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 2)
})

test("removes multiple empty user messages, keeps non-empty ones in order", () => {
    const m1 = buildUserMessage([{ type: "text", text: "real content" }], "msg-1")
    const m2 = buildUserMessage([{ type: "text", text: "" }], "msg-2")
    const m3 = buildAssistantMessage([{ type: "text", text: "" }], "msg-3")
    const m4 = buildUserMessage([{ type: "text", text: "  " }], "msg-4")
    const m5 = buildUserMessage([{ type: "text", text: "more content" }], "msg-5")
    const messages = [m1, m2, m3, m4, m5]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 2)
    assert.equal(messages.length, 3)
    assert.equal(messages[0].info.id, "msg-1")
    assert.equal(messages[1].info.id, "msg-3")
    assert.equal(messages[2].info.id, "msg-5")
})

test("empty array returns 0", () => {
    const messages: WithParts[] = []
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 0)
})

test("all non-empty messages returns 0", () => {
    const messages = [
        buildUserMessage([{ type: "text", text: "a" }]),
        buildUserMessage([{ type: "text", text: "b" }]),
    ]
    const removed = dropEmptyUserMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 2)
})
