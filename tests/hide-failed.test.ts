import assert from "node:assert/strict"
import test from "node:test"
import { hideFailedCompressCalls } from "../lib/compress/hide-failed"
import type { WithParts } from "../lib/state"

function makeCompressPart(status: "completed" | "error", callID: string, output?: string) {
    return {
        type: "tool" as const,
        callID,
        tool: "compress",
        state: {
            status,
            input: { content: [{ startId: "m00001", endId: "m00010", summary: "test" }] },
            output: output ?? (status === "error" ? "Error: bad boundaries" : "compressed"),
        },
    }
}

function makeOtherToolPart(status: "completed" | "error") {
    return {
        type: "tool" as const,
        callID: "call-other",
        tool: "bash",
        state: {
            status,
            input: { command: "ls" },
            output: status === "error" ? "Error: not found" : "file.txt",
        },
    }
}

function makeTextPart(text: string) {
    return { type: "text" as const, text }
}

function makeMessage(id: string, role: "user" | "assistant", parts: any[]): WithParts {
    return {
        info: { id, role, sessionID: "ses-test", time: { created: 1 } } as any,
        parts,
    }
}

test("hideFailedCompressCalls: removes failed compress tool parts", () => {
    const messages = [
        makeMessage("msg-1", "user", [makeTextPart("hello")]),
        makeMessage("msg-2", "assistant", [
            makeTextPart("Let me compress"),
            makeCompressPart("error", "call-1"),
        ]),
        makeMessage("msg-3", "user", [makeTextPart("ok")]),
    ]

    const hidden = hideFailedCompressCalls(messages)

    assert.equal(hidden, 1)
    assert.equal(messages.length, 3)
    assert.equal(messages[1]!.parts.length, 1)
    assert.equal(messages[1]!.parts[0]!.type, "text")
})

test("hideFailedCompressCalls: splices message when all parts are failed compress calls", () => {
    const messages = [
        makeMessage("msg-1", "user", [makeTextPart("hello")]),
        makeMessage("msg-2", "assistant", [makeCompressPart("error", "call-1")]),
        makeMessage("msg-3", "user", [makeTextPart("ok")]),
    ]

    const hidden = hideFailedCompressCalls(messages)

    assert.equal(hidden, 1)
    assert.equal(messages.length, 2)
    assert.equal(messages[0]!.info.id, "msg-1")
    assert.equal(messages[1]!.info.id, "msg-3")
})

test("hideFailedCompressCalls: does NOT remove successful compress calls", () => {
    const messages = [
        makeMessage("msg-1", "user", [makeTextPart("hello")]),
        makeMessage("msg-2", "assistant", [
            makeCompressPart("completed", "call-1"),
        ]),
        makeMessage("msg-3", "user", [makeTextPart("ok")]),
    ]

    const hidden = hideFailedCompressCalls(messages)

    assert.equal(hidden, 0)
    assert.equal(messages.length, 3)
    assert.equal(messages[1]!.parts.length, 1)
})

test("hideFailedCompressCalls: does NOT remove failed non-compress tool calls", () => {
    const messages = [
        makeMessage("msg-1", "user", [makeTextPart("hello")]),
        makeMessage("msg-2", "assistant", [
            makeOtherToolPart("error"),
        ]),
        makeMessage("msg-3", "user", [makeTextPart("ok")]),
    ]

    const hidden = hideFailedCompressCalls(messages)

    assert.equal(hidden, 0)
    assert.equal(messages.length, 3)
    assert.equal(messages[1]!.parts.length, 1)
})

test("hideFailedCompressCalls: removes multiple failed compress calls across messages", () => {
    const messages = [
        makeMessage("msg-1", "user", [makeTextPart("hello")]),
        makeMessage("msg-2", "assistant", [
            makeCompressPart("error", "call-1"),
        ]),
        makeMessage("msg-3", "user", [makeTextPart("retry")]),
        makeMessage("msg-4", "assistant", [
            makeCompressPart("error", "call-2"),
        ]),
        makeMessage("msg-5", "assistant", [
            makeCompressPart("completed", "call-3"),
        ]),
    ]

    const hidden = hideFailedCompressCalls(messages)

    assert.equal(hidden, 2)
    assert.equal(messages.length, 3)
    assert.equal(messages[0]!.info.id, "msg-1")
    assert.equal(messages[1]!.info.id, "msg-3")
    assert.equal(messages[2]!.info.id, "msg-5")
    assert.equal(messages[2]!.parts[0]!.state.status, "completed")
})

test("hideFailedCompressCalls: handles empty messages array", () => {
    const hidden = hideFailedCompressCalls([])
    assert.equal(hidden, 0)
})

test("hideFailedCompressCalls: handles messages with no parts", () => {
    const messages = [
        makeMessage("msg-1", "user", []),
    ]
    const hidden = hideFailedCompressCalls(messages)
    assert.equal(hidden, 0)
})
