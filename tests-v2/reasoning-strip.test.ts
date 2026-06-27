import assert from "node:assert/strict"
import test from "node:test"
import { stripStaleMetadata } from "../lib-v2/messages/reasoning-strip"
import type { WithParts } from "../lib-v2/state"

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
