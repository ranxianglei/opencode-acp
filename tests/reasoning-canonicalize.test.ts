import assert from "node:assert/strict"
import test from "node:test"
import { canonicalizeReasoningShape } from "../lib/messages/reasoning-canonicalize"
import type { WithParts } from "../lib/state"

const SID = "ses-reasoning-canonicalize"

// Byte-pinned to the kernel demoted-thinking FORMS variant this plugin targets
// (billion-context kernel/src/wire/demoted-thinking.ts) — a silent form change
// here re-breaks wire-shape stability, so assert the exact bytes, not the shape.
const OPEN = "\x3cthinking\x3e\n"
const CLOSE = "\n\x3c/thinking\x3e"

function assistantMsg(id: string, parts: WithParts["parts"]): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "assistant",
            time: { created: 2 },
        } as WithParts["info"],
        parts,
    }
}

function userMsg(id: string, parts: WithParts["parts"]): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "assistant",
            model: { providerID: "openai", modelID: "gpt-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

function textPart(id: string, msgId: string, text: string): WithParts["parts"][number] {
    return { id, messageID: msgId, sessionID: SID, type: "text", text } as WithParts["parts"][number]
}

function reasoningPart(id: string, msgId: string, text: string): WithParts["parts"][number] {
    return { id, messageID: msgId, sessionID: SID, type: "reasoning", text } as WithParts["parts"][number]
}

function toolPart(id: string, msgId: string): WithParts["parts"][number] {
    return {
        id,
        messageID: msgId,
        sessionID: SID,
        type: "tool",
        tool: "bash",
        callID: `${id}-call`,
        state: { status: "completed", output: "out" },
    } as WithParts["parts"][number]
}

function imagePart(id: string, msgId: string): WithParts["parts"][number] {
    return { id, messageID: msgId, sessionID: SID, type: "image" } as WithParts["parts"][number]
}

test("returns 0 and leaves parts untouched when no reasoning parts exist", () => {
    const messages = [
        userMsg("u1", [textPart("p-u1", "u1", "hello")]),
        assistantMsg("a1", [textPart("p-a1", "a1", "world")]),
    ]
    const before = JSON.stringify(messages)
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 0)
    assert.equal(JSON.stringify(messages), before)
})

test("merges [reasoning, text] into one canonical tagged text part", () => {
    const messages = [
        assistantMsg("a1", [reasoningPart("p-r1", "a1", "R1"), textPart("p-t1", "a1", "T1")]),
    ]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 1)
    const part = messages[0].parts[0]!
    assert.equal(part.type, "text")
    if (part.type === "text") {
        assert.equal(part.text, `${OPEN}R1${CLOSE}\nT1`)
    }
})

test("places the merged part at the first folded slot for [text, reasoning]", () => {
    const messages = [
        assistantMsg("a1", [textPart("p-t1", "a1", "T1"), reasoningPart("p-r1", "a1", "R1")]),
    ]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 1)
    const part = messages[0].parts[0]!
    if (part.type === "text") {
        assert.equal(part.text, `${OPEN}R1${CLOSE}\nT1`)
    } else {
        assert.fail(`expected merged text part, got ${part.type}`)
    }
})

test("preserves tool parts in their original relative position", () => {
    const tool = toolPart("p-tool", "a1")
    const messages = [
        assistantMsg("a1", [reasoningPart("p-r1", "a1", "R1"), tool, textPart("p-t1", "a1", "T1")]),
    ]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 2)
    assert.equal(messages[0].parts[1], tool, "tool part identity preserved")
    const merged = messages[0].parts[0]!
    if (merged.type === "text") {
        assert.equal(merged.text, `${OPEN}R1${CLOSE}\nT1`)
    } else {
        assert.fail(`expected merged text part, got ${merged.type}`)
    }
})

test("joins multiple reasoning and text parts in encounter order", () => {
    const messages = [
        assistantMsg("a1", [
            reasoningPart("p-r1", "a1", "R1"),
            textPart("p-t1", "a1", "T1"),
            reasoningPart("p-r2", "a1", "R2"),
            textPart("p-t2", "a1", "T2"),
        ]),
    ]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 1)
    const part = messages[0].parts[0]!
    if (part.type === "text") {
        // Join parity with the host serializer: each side concatenates its own
        // same-kind parts with "" before placement.
        assert.equal(part.text, `${OPEN}R1R2${CLOSE}\nT1T2`)
    }
})

test("produces a tag-only part when reasoning has no sibling text", () => {
    const messages = [assistantMsg("a1", [reasoningPart("p-r1", "a1", "R1")])]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 1)
    const part = messages[0].parts[0]!
    if (part.type === "text") {
        assert.equal(part.text, `${OPEN}R1${CLOSE}`)
    } else {
        assert.fail(`expected tag-only text part, got ${part.type}`)
    }
})

test("skips messages whose reasoning parts are all empty strings", () => {
    const messages = [
        assistantMsg("a1", [reasoningPart("p-r1", "a1", ""), textPart("p-t1", "a1", "T1")]),
    ]
    const before = JSON.stringify(messages)
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 0)
    assert.equal(JSON.stringify(messages), before)
})

test("leaves non-assistant messages untouched", () => {
    const messages = [userMsg("u1", [textPart("p-u1", "u1", "user text")])]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 0)
    assert.equal(messages[0].parts.length, 1)
})

test("is idempotent: a second pass changes nothing (prefix-cache byte stability)", () => {
    const messages = [
        assistantMsg("a1", [reasoningPart("p-r1", "a1", "R1"), textPart("p-t1", "a1", "T1")]),
    ]
    assert.equal(canonicalizeReasoningShape(messages), 1)
    const afterFirst = JSON.stringify(messages)
    assert.equal(canonicalizeReasoningShape(messages), 0)
    assert.equal(JSON.stringify(messages), afterFirst)
})

test("reuses the first folded part's id on the synthesized text part", () => {
    const messages = [
        assistantMsg("a1", [reasoningPart("p-r1", "a1", "R1"), textPart("p-t1", "a1", "T1")]),
    ]
    canonicalizeReasoningShape(messages)
    const part = messages[0].parts[0]!
    assert.equal(part.id, "p-r1")
    assert.equal(part.messageID, "a1")
    assert.equal(part.sessionID, SID)
})

test("preserves image part positions around folded parts", () => {
    const image = imagePart("p-img", "a1")
    const messages = [
        assistantMsg("a1", [image, reasoningPart("p-r1", "a1", "R1"), textPart("p-t1", "a1", "T1")]),
    ]
    const normalized = canonicalizeReasoningShape(messages)
    assert.equal(normalized, 1)
    assert.equal(messages[0].parts.length, 2)
    assert.equal(messages[0].parts[0], image, "image part identity preserved")
    assert.equal(messages[0].parts[1]?.type, "text")
})
