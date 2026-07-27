import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { messageHasCompress, messageHasCompressAttempt } from "../lib/messages/query"
import type { WithParts } from "../lib/messages/query"

function makeAssistantWithCompress(status: string): WithParts {
    return {
        info: { id: "msg-1", role: "assistant", sessionID: "ses-1", time: { created: 1 } },
        parts: [
            {
                type: "tool",
                tool: "compress",
                state: { status, input: {}, output: "result" },
            },
        ],
    } as unknown as WithParts
}

function makeAssistantWithoutCompress(): WithParts {
    return {
        info: { id: "msg-2", role: "assistant", sessionID: "ses-1", time: { created: 1 } },
        parts: [{ type: "text", text: "hello" }],
    } as unknown as WithParts
}

describe("messageHasCompressAttempt (Issue #216 Defect 2)", () => {
    test("detects successful compress", () => {
        assert.equal(messageHasCompressAttempt(makeAssistantWithCompress("completed")), true)
    })

    test("detects failed compress (status=error)", () => {
        assert.equal(messageHasCompressAttempt(makeAssistantWithCompress("error")), true)
    })

    test("detects failed compress (status=invalid_request_error)", () => {
        assert.equal(messageHasCompressAttempt(makeAssistantWithCompress("invalid_request_error")), true)
    })

    test("returns false for non-compress tool", () => {
        const msg = {
            info: { id: "msg-3", role: "assistant", sessionID: "ses-1", time: { created: 1 } },
            parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }],
        } as unknown as WithParts
        assert.equal(messageHasCompressAttempt(msg), false)
    })

    test("returns false for plain text message", () => {
        assert.equal(messageHasCompressAttempt(makeAssistantWithoutCompress()), false)
    })
})

describe("messageHasCompress vs messageHasCompressAttempt", () => {
    test("messageHasCompress only counts completed", () => {
        assert.equal(messageHasCompress(makeAssistantWithCompress("completed")), true)
        assert.equal(messageHasCompress(makeAssistantWithCompress("error")), false)
    })

    test("messageHasCompressAttempt counts any status", () => {
        assert.equal(messageHasCompressAttempt(makeAssistantWithCompress("completed")), true)
        assert.equal(messageHasCompressAttempt(makeAssistantWithCompress("error")), true)
    })
})
