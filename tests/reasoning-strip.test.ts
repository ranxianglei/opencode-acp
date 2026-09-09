import assert from "node:assert/strict"
import test from "node:test"
import { dropCompressReasoning, stripStaleMetadata } from "../lib/messages/reasoning-strip"
import type { WithParts } from "../lib/state"

const SID = "ses-reasoning-strip"

function userMsg(id: string, modelID: string, providerID: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "assistant",
            model: { modelID, providerID },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [{ id: `${id}-p`, messageID: id, sessionID: SID, type: "text", text: "user text" }],
    }
}

function assistantMsg(
    id: string,
    modelID?: string,
    providerID?: string,
    parts?: any[],
): WithParts {
    const info: any = {
        id,
        role: "assistant",
        sessionID: SID,
        agent: "assistant",
        time: { created: 2 },
    }
    if (modelID !== undefined) info.modelID = modelID
    if (providerID !== undefined) info.providerID = providerID
    return {
        info,
        parts: parts ?? [
            { id: `${id}-p`, messageID: id, sessionID: SID, type: "text", text: "assistant text", metadata: { foo: "bar" } },
        ],
    }
}

test("stripStaleMetadata is a no-op when no user message exists", () => {
    const messages: WithParts[] = [assistantMsg("a1", "model-a", "prov-a")]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[0]!.parts[0]!, "metadata should remain when no user message")
})

test("stripStaleMetadata removes metadata from assistant parts with different model", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "metadata should be stripped from different-model assistant")
})

test("stripStaleMetadata preserves metadata for same-model assistant parts", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "claude-4", "anthropic"),
    ]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[1]!.parts[0]!, "metadata should remain for same-model assistant")
})

test("stripStaleMetadata only strips from text/tool/reasoning parts", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai", [
            { id: "p1", messageID: "a1", sessionID: SID, type: "text", text: "text", metadata: { a: 1 } },
            { id: "p2", messageID: "a1", sessionID: SID, type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "out" }, metadata: { b: 2 } },
            { id: "p3", messageID: "a1", sessionID: SID, type: "reasoning", text: "thinking", metadata: { c: 3 } },
            { id: "p4", messageID: "a1", sessionID: SID, type: "image", metadata: { d: 4 } },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "text metadata stripped")
    assert.ok(!("metadata" in messages[1]!.parts[1]!), "tool metadata stripped")
    assert.ok(!("metadata" in messages[1]!.parts[2]!), "reasoning metadata stripped")
    assert.ok("metadata" in messages[1]!.parts[3]!, "image metadata preserved (not text/tool/reasoning)")
})

test("stripStaleMetadata preserves parts without metadata property", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai", [
            { id: "p1", messageID: "a1", sessionID: SID, type: "text", text: "no metadata here" },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.equal(messages[1]!.parts[0]!.type, "text", "part should still exist")
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "part should not have metadata")
})

test("stripStaleMetadata handles undefined modelID/providerID (Bug 8 fix)", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "metadata stripped when assistant has no model info")
})

test("stripStaleMetadata only considers the last user message's model", () => {
    const messages: WithParts[] = [
        userMsg("u1", "gpt-4", "openai"),
        assistantMsg("a1", "gpt-4", "openai"),
        userMsg("u2", "claude-4", "anthropic"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "a1 metadata stripped (u2 has different model)")
})

// ── dropCompressReasoning (#368): drop oversized reasoning from closed-turn
// compress tool calls. Pure function — mutates the request array in place and
// returns the number of removed reasoning parts. ──

function compressPart(id: string): any {
    return {
        id,
        messageID: "x",
        sessionID: SID,
        type: "tool",
        tool: "compress",
        callID: `call-${id}`,
        state: { status: "completed", output: "compressed" },
    }
}

function skillPart(id: string): any {
    return {
        id,
        messageID: "x",
        sessionID: SID,
        type: "tool",
        tool: "skill",
        callID: `call-${id}`,
        state: { status: "completed", output: "skill ran" },
    }
}

function reasoningPart(id: string, text: string): any {
    return { id, messageID: "x", sessionID: SID, type: "reasoning", text }
}

test("dropCompressReasoning removes reasoning from closed-turn compress calls above threshold", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    const removed = dropCompressReasoning(messages, 2048)
    assert.equal(removed, 1)
    assert.deepEqual(
        messages[1]!.parts.map((p) => p.type),
        ["tool"],
    )
})

test("dropCompressReasoning keeps the reasoning of the active round (at/after last user message)", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
        assistantMsg("a2", undefined, undefined, [
            reasoningPart("r2", "y".repeat(3000)),
            compressPart("t2"),
        ]),
    ]
    const removed = dropCompressReasoning(messages, 2048)
    assert.equal(removed, 1)
    // a2 is the ACTIVE round (strictly after the last user message) — untouched.
    assert.equal(messages[3]!.parts.length, 2)
    assert.equal(messages[3]!.parts[0]!.type, "reasoning")
})

test("dropCompressReasoning ignores non-compress tool calls (skill is protected but NOT targeted)", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            skillPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    const removed = dropCompressReasoning(messages, 2048)
    assert.equal(removed, 0)
    assert.equal(messages[1]!.parts.length, 2)
})

test("dropCompressReasoning targets compress parts regardless of tool status (intent: failed attempts too)", () => {
    // Pins the design decision that the selector matches tool === "compress"
    // with NO state.status filter — unlike messageHasCompress, which requires
    // "completed". A failed/pending compress call is equally hard-exempt from
    // compression, so its oversized thinking is equally part of the floor.
    const pending: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            { ...compressPart("t1"), state: { status: "pending" } },
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(pending, 2048), 1)
    assert.deepEqual(
        pending[1]!.parts.map((p) => p.type),
        ["tool"],
    )

    const errored: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            { ...compressPart("t1"), state: { status: "error", output: "bad range" } },
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(errored, 2048), 1)
    assert.deepEqual(
        errored[1]!.parts.map((p) => p.type),
        ["tool"],
    )
})

test("dropCompressReasoning threshold is strict: equal length is kept, larger is dropped", () => {
    const at = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(2048)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(at, 2048), 0, "length == threshold → kept")

    const above = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(2049)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(above, 2048), 1, "length > threshold → dropped")
})

test("dropCompressReasoning threshold 0 drops unconditionally, small thinkings kept otherwise", () => {
    const small = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "tiny"),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(small, 2048), 0, "small thinking survives the size gate")
    assert.equal(
        dropCompressReasoning(
            [
                userMsg("u1", "m", "p"),
                assistantMsg("a1", undefined, undefined, [
                    reasoningPart("r1", "tiny"),
                    compressPart("t1"),
                ]),
                userMsg("u2", "m", "p"),
            ],
            0,
        ),
        1,
        "threshold 0 = unconditional drop",
    )
})

test("dropCompressReasoning sums multiple reasoning parts before comparing", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(1200)),
            reasoningPart("r2", "x".repeat(1200)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    // Each part alone is below 2048, but the message total (2400) exceeds it.
    const removed = dropCompressReasoning(messages, 2048)
    assert.equal(removed, 2)
    assert.deepEqual(
        messages[1]!.parts.map((p) => p.type),
        ["tool"],
    )
})

test("dropCompressReasoning preserves non-reasoning parts (tool + text survive)", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            { id: "p-txt", messageID: "a1", sessionID: SID, type: "text", text: "summary text" },
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    const removed = dropCompressReasoning(messages, 2048)
    assert.equal(removed, 1)
    assert.deepEqual(
        messages[1]!.parts.map((p) => p.type),
        ["text", "tool"],
    )
})

test("dropCompressReasoning is idempotent — a second run removes nothing", () => {
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(messages, 2048), 1)
    assert.equal(dropCompressReasoning(messages, 2048), 0)
})

test("dropCompressReasoning fail-safe: no user message → nothing dropped", () => {
    const messages: WithParts[] = [
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            compressPart("t1"),
        ]),
    ]
    assert.equal(dropCompressReasoning(messages, 2048), 0)
    assert.equal(messages[0]!.parts.length, 2)
})

test("dropCompressReasoning handles a user message at index 0 (single closed round still works)", () => {
    // user(0) → assistant compress(1) → user(2): index 1 IS strippable.
    const messages: WithParts[] = [
        userMsg("u1", "m", "p"),
        assistantMsg("a1", undefined, undefined, [
            reasoningPart("r1", "x".repeat(3000)),
            compressPart("t1"),
        ]),
        userMsg("u2", "m", "p"),
    ]
    assert.equal(dropCompressReasoning(messages, 2048), 1)
})
