/**
 * Tests for protecting compress tool calls (which carry summaries) from being
 * included in subsequent compression ranges.
 *
 * Background: compress tool calls live inside assistant messages a few positions
 * after the range they compressed. When the model issues a new sequential
 * compress whose range starts right after the previous one's end, the previous
 * compress call falls inside the new range and gets pruned — destroying the
 * accumulated summary chain. Adding "compress" to the default protectedTools
 * (COMPRESS_DEFAULT_PROTECTED_TOOLS) makes filterProtectedToolMessages
 * hard-exclude those messages (Bug 39 mechanism), so summaries survive.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { messageContainsProtectedTool, filterProtectedToolMessages } from "../lib/compress/protected-content"
import type { SelectionResolution, SearchContext } from "../lib/compress/types"
import type { WithParts } from "../lib/state"

const DEFAULT_PROTECTED = ["skill", "compress"]

function makeCompressCallPart(callID: string, summary: string) {
    return {
        type: "tool" as const,
        callID,
        tool: "compress",
        state: {
            status: "completed" as const,
            input: { content: [{ startId: "m00001", endId: "m00010", summary }] },
            output: "compressed",
        },
    }
}

function makeTextPart(id: string, text: string) {
    return { type: "text" as const, id, text }
}

function makeMessage(id: string, role: "user" | "assistant", parts: any[]): WithParts {
    return {
        info: { id, role, sessionID: "ses-test", time: { created: 1 } } as any,
        parts,
    }
}

function makeSearchContext(messages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    messages.forEach((m, i) => {
        rawMessagesById.set(m.info.id, m)
        rawIndexById.set(m.info.id, i)
    })
    return {
        rawMessages: messages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId: new Map(),
    }
}

function makeSelection(messageIds: string[]): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0, messageId: messageIds[0] },
        endReference: { kind: "message", rawIndex: messageIds.length - 1, messageId: messageIds[messageIds.length - 1] },
        messageIds,
        messageTokenById: new Map(messageIds.map((id) => [id, 100])),
        toolIds: [],
        requiredBlockIds: [],
    }
}

test("messageContainsProtectedTool: compress tool call is protected when 'compress' is in the list", () => {
    const msg = makeMessage("msg-compress-call", "assistant", [
        makeTextPart("p1", "Let me compress the earlier findings."),
        makeCompressCallPart("call-1", "Summary of earlier work..."),
    ])
    assert.equal(messageContainsProtectedTool(msg, DEFAULT_PROTECTED, []), true)
})

test("messageContainsProtectedTool: compress tool call is NOT protected when 'compress' is absent (opt-out)", () => {
    const msg = makeMessage("msg-compress-call", "assistant", [
        makeCompressCallPart("call-1", "Summary of earlier work..."),
    ])
    assert.equal(messageContainsProtectedTool(msg, ["skill"], []), false)
    assert.equal(messageContainsProtectedTool(msg, [], []), false)
})

test("messageContainsProtectedTool: plain text message is never protected", () => {
    const msg = makeMessage("msg-text", "user", [makeTextPart("p1", "Hello world")])
    assert.equal(messageContainsProtectedTool(msg, DEFAULT_PROTECTED, []), false)
})

test("filterProtectedToolMessages: removes compress-call message from selection, keeps surrounding messages", () => {
    const compressMsg = makeMessage("msg-compress", "assistant", [
        makeTextPart("p1", "Compressing now."),
        makeCompressCallPart("call-compress", "Previous summary content..."),
    ])
    const plainMsg1 = makeMessage("msg-plain-1", "user", [makeTextPart("p2", "User question")])
    const plainMsg2 = makeMessage("msg-plain-2", "assistant", [makeTextPart("p3", "Assistant answer")])

    const ctx = makeSearchContext([plainMsg1, compressMsg, plainMsg2])
    const selection = makeSelection(["msg-plain-1", "msg-compress", "msg-plain-2"])

    const result = filterProtectedToolMessages(selection, ctx, DEFAULT_PROTECTED, [])

    assert.deepEqual(result.messageIds, ["msg-plain-1", "msg-plain-2"])
    assert.equal(result.messageTokenById.size, 2)
    assert.ok(result.messageTokenById.has("msg-plain-1"))
    assert.ok(result.messageTokenById.has("msg-plain-2"))
    assert.ok(!result.messageTokenById.has("msg-compress"))
})

test("filterProtectedToolMessages: no-op when 'compress' is not in protectedTools (old behavior)", () => {
    const compressMsg = makeMessage("msg-compress", "assistant", [
        makeCompressCallPart("call-1", "Summary..."),
    ])
    const ctx = makeSearchContext([compressMsg])
    const selection = makeSelection(["msg-compress"])

    const result = filterProtectedToolMessages(selection, ctx, ["skill"], [])
    assert.deepEqual(result.messageIds, ["msg-compress"])
})

test("filterProtectedToolMessages: all-compress-call selection becomes empty (all excluded)", () => {
    const msg1 = makeMessage("msg-c1", "assistant", [makeCompressCallPart("c1", "Summary A")])
    const msg2 = makeMessage("msg-c2", "assistant", [makeCompressCallPart("c2", "Summary B")])

    const ctx = makeSearchContext([msg1, msg2])
    const selection = makeSelection(["msg-c1", "msg-c2"])

    const result = filterProtectedToolMessages(selection, ctx, DEFAULT_PROTECTED, [])
    assert.equal(result.messageIds.length, 0)
    assert.equal(result.messageTokenById.size, 0)
})
