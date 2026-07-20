import assert from "node:assert/strict"
import test from "node:test"
import { dropEmptyMessages } from "../lib/messages/utils"
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
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("removes user message with empty text part", () => {
    const messages = [buildUserMessage([{ type: "text", text: "" }])]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("removes user message with whitespace-only text", () => {
    const messages = [buildUserMessage([{ type: "text", text: "   \n\t  " }])]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("preserves user message with text content", () => {
    const msg = buildUserMessage([{ type: "text", text: "hello world" }])
    const messages = [msg]
    const removed = dropEmptyMessages(messages)
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
    const removed = dropEmptyMessages(messages)
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
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-tool")
})

test("removes empty assistant messages", () => {
    const messages = [buildAssistantMessage([]), buildAssistantMessage([{ type: "text", text: "" }])]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 2)
    assert.equal(messages.length, 0)
})

test("removes empty messages of both roles, keeps non-empty in order", () => {
    const m1 = buildUserMessage([{ type: "text", text: "real content" }], "msg-1")
    const m2 = buildUserMessage([{ type: "text", text: "" }], "msg-2")
    const m3 = buildAssistantMessage([{ type: "text", text: "" }], "msg-3")
    const m4 = buildUserMessage([{ type: "text", text: "  " }], "msg-4")
    const m5 = buildUserMessage([{ type: "text", text: "more content" }], "msg-5")
    const messages = [m1, m2, m3, m4, m5]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 3)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].info.id, "msg-1")
    assert.equal(messages[1].info.id, "msg-5")
})

test("preserves assistant message with errored tool call", () => {
    const msg = buildAssistantMessage(
        [{ type: "tool", tool: "bash", state: { status: "error", output: "boom" } }],
        "msg-err",
    )
    const messages = [msg]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-err")
})

test("preserves assistant message with pending tool call", () => {
    const msg = buildAssistantMessage(
        [{ type: "tool", tool: "bash", state: { status: "pending" } }],
        "msg-pending",
    )
    const messages = [msg]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-pending")
})

test("empty array returns 0", () => {
    const messages: WithParts[] = []
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 0)
})

test("all non-empty messages returns 0", () => {
    const messages = [
        buildUserMessage([{ type: "text", text: "a" }]),
        buildUserMessage([{ type: "text", text: "b" }]),
    ]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 2)
})

// [FIX #20] Regression coverage for the empty-user-message freeze.
// ACP's `sendIgnoredMessage` injects a user-role message whose only part is
// `{ type: "text", text: <notification>, ignored: true }`. opencode strips
// ignored parts before the LLM call, leaving an empty user message that
// triggers zhipuai-lb HTTP 400 (code 1214, isRetryable: false). These tests
// pin dropEmptyMessages to remove such messages before they reach the provider.
test("removes user message whose only part is ignored text", () => {
    const messages = [
        buildUserMessage([
            { type: "text", text: "▣ ACP | Context 80K → 60K", ignored: true } as any,
        ]),
    ]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("preserves user message that mixes ignored text with real content", () => {
    const kept = buildUserMessage(
        [
            { type: "text", text: "▣ ACP | Context 80K → 60K", ignored: true } as any,
            { type: "text", text: "user asked to refactor the auth module" },
        ],
        "msg-mixed",
    )
    const messages = [kept]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-mixed")
})

test("removes user message with ignored text plus whitespace-only text", () => {
    const messages = [
        buildUserMessage(
            [
                { type: "text", text: "▣ ACP | done", ignored: true } as any,
                { type: "text", text: "   " },
            ],
            "msg-ignored-plus-ws",
        ),
    ]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 1)
    assert.equal(messages.length, 0)
})

test("preserves user message with ignored text and an errored tool call", () => {
    const kept = buildUserMessage(
        [
            { type: "text", text: "ignored notification", ignored: true } as any,
            { type: "tool", tool: "bash", state: { status: "error", output: "boom" } },
        ],
        "msg-ignored-plus-error",
    )
    const messages = [kept]
    const removed = dropEmptyMessages(messages)
    assert.equal(removed, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, "msg-ignored-plus-error")
})
