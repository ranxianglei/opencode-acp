/**
 * Tests for stripStaleCompressCalls — removes compress tool-call parts from
 * previous turns so the API context doesn't duplicate the summaries already
 * injected as recaps.
 *
 * Test cases (from Oracle review W1):
 *   (a) prev-turn compress stripped
 *   (b) current-turn compress preserved
 *   (c) all-compress message removed entirely
 *   (d) multiple compress calls stripped in one pass
 *   (e) no user message — no-op
 *   (f) non-compress tool parts preserved
 *   (g) idempotent on second run
 */

import assert from "node:assert/strict"
import test from "node:test"
import { stripStaleCompressCalls } from "../lib/messages/prune"
import type { WithParts } from "../lib/state"

function mkAssistant(parts: { type: string; tool?: string; text?: string }[]): WithParts {
    return {
        info: { id: `msg_${Math.random().toString(36).slice(2)}`, role: "assistant" },
        message: { info: { id: "", role: "assistant", created: Date.now() }, parts: [] },
        parts: parts as any,
    }
}

function mkUser(text: string): WithParts {
    return {
        info: { id: `msg_${Math.random().toString(36).slice(2)}`, role: "user" },
        message: { info: { id: "", role: "user", created: Date.now() }, parts: [] },
        parts: [{ type: "text", text }],
    }
}

const compressPart = { type: "tool", tool: "compress", state: { status: "completed" } }
const bashPart = { type: "tool", tool: "bash", state: { status: "completed" } }
const textPart = { type: "text", text: "response" }

test("stripStaleCompressCalls: (a) prev-turn compress stripped, other parts preserved", () => {
    const prevAssistant = mkAssistant([compressPart, textPart])
    const user = mkUser("new message")
    const messages = [prevAssistant, user]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 1)
    assert.equal(messages.length, 2)
    assert.equal(messages[0]!.parts.length, 1)
    assert.equal(messages[0]!.parts[0]!.type, "text")
})

test("stripStaleCompressCalls: (b) current-turn compress preserved", () => {
    const user = mkUser("new message")
    const currentAssistant = mkAssistant([compressPart, textPart])
    const messages = [user, currentAssistant]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 0)
    assert.equal(messages.length, 2)
    assert.equal(messages[1]!.parts.length, 2)
})

test("stripStaleCompressCalls: (c) all-compress message removed entirely", () => {
    const allCompress = mkAssistant([compressPart])
    const user = mkUser("new message")
    const messages = [allCompress, user]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.info.role, "user")
})

test("stripStaleCompressCalls: (d) multiple compress calls stripped in one pass", () => {
    const a1 = mkAssistant([compressPart, textPart])
    const a2 = mkAssistant([compressPart, bashPart])
    const user = mkUser("new message")
    const messages = [a1, a2, user]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 2)
    assert.equal(messages.length, 3)
    assert.equal(messages[0]!.parts.length, 1)
    assert.equal(messages[0]!.parts[0]!.type, "text")
    assert.equal(messages[1]!.parts.length, 1)
    assert.equal(messages[1]!.parts[0]!.tool, "bash")
})

test("stripStaleCompressCalls: (e) no user message — no-op", () => {
    const a1 = mkAssistant([compressPart, textPart])
    const messages = [a1]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.parts.length, 2)
})

test("stripStaleCompressCalls: (f) non-compress tool parts preserved in prev turns", () => {
    const prevAssistant = mkAssistant([bashPart, compressPart, textPart])
    const user = mkUser("new message")
    const messages = [prevAssistant, user]

    const stripped = stripStaleCompressCalls(messages)

    assert.equal(stripped, 1)
    assert.equal(messages[0]!.parts.length, 2)
    assert.equal(messages[0]!.parts[0]!.tool, "bash")
    assert.equal(messages[0]!.parts[1]!.type, "text")
})

test("stripStaleCompressCalls: (g) idempotent on second run", () => {
    const prevAssistant = mkAssistant([compressPart, textPart])
    const user = mkUser("new message")
    const messages = [prevAssistant, user]

    stripStaleCompressCalls(messages)
    const stripped2 = stripStaleCompressCalls(messages)

    assert.equal(stripped2, 0)
    assert.equal(messages.length, 2)
    assert.equal(messages[0]!.parts.length, 1)
})
