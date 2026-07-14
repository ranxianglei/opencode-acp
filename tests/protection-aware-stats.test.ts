import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import type { WithParts } from "../lib/state"
import { buildCompressibleRanges, estimateContextComposition } from "../lib/messages/inject/utils"
import { assignMessageRefs } from "../lib/message-ids"

const SID = "ses-protect-test"

function makeMsg(
    id: string,
    role: "user" | "assistant",
    text: string,
    toolParts: any[] = [],
): WithParts {
    const parts: any[] = []
    if (text) parts.push({ type: "text", text })
    for (const tp of toolParts) parts.push(tp)
    return {
        info: { id, role, sessionID: SID, agent: "a", time: { created: 1 } } as any,
        parts,
    }
}

function toolPart(callID: string, tool: string, input?: any): any {
    return { type: "tool", callID, tool, state: { status: "completed", input } }
}

function setupRefs(state: ReturnType<typeof createSessionState>, messages: WithParts[]): void {
    assignMessageRefs(state, messages)
}

test("buildCompressibleRanges excludes messages with protected tools", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "response", [toolPart("t1", "bash", { command: "ls" })]),
        makeMsg("m3", "assistant", "skill output", [toolPart("t2", "skill")]),
        makeMsg("m4", "assistant", "normal text"),
    ]
    setupRefs(state, messages)

    const ranges = buildCompressibleRanges(messages, state, ["skill"])
    const allRefs = ranges.flatMap((r) => [r.startRef, r.endRef])
    assert.ok(
        !allRefs.some((r) => r.includes("m00003")),
        "protected message m3 excluded from all ranges",
    )
    assert.ok(ranges.length >= 1, "at least one range remains")
})

test("buildCompressibleRanges includes all messages when no protected tools configured", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "skill output", [toolPart("t1", "skill")]),
        makeMsg("m3", "assistant", "normal text"),
    ]
    setupRefs(state, messages)

    const ranges = buildCompressibleRanges(messages, state, [])
    assert.ok(ranges.length >= 1)
    assert.ok(ranges[0].count >= 3, "all messages included")
})

test("buildCompressibleRanges respects protectedFilePatterns", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "reading file", [
            toolPart("t1", "read", { filePath: "src/secret.ts" }),
        ]),
        makeMsg("m3", "assistant", "normal text"),
    ]
    setupRefs(state, messages)

    const ranges = buildCompressibleRanges(messages, state, [], ["src/**/*.ts"])
    assert.ok(
        !ranges.some((r) => r.startRef.includes("m2") || r.endRef.includes("m2")),
        "protected file message excluded from ranges",
    )
})

test("estimateContextComposition tracks protectedTokens", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "a".repeat(4000)),
        makeMsg("m2", "assistant", "protected skill output", [toolPart("t1", "skill")]),
        makeMsg("m3", "assistant", "b".repeat(2000)),
    ]
    setupRefs(state, messages)

    const comp = estimateContextComposition(messages, state, ["skill"])
    assert.ok(comp.protectedTokens > 0, "protected tokens counted")
    assert.ok(comp.protectedTokens < comp.total, "protected is subset of total")
})

test("estimateContextComposition protectedTokens is 0 when no tools protected", () => {
    const state = createSessionState()
    const messages = [makeMsg("m1", "user", "hello"), makeMsg("m2", "assistant", "text")]
    setupRefs(state, messages)

    const comp = estimateContextComposition(messages, state, [])
    assert.equal(comp.protectedTokens, 0)
})

test("estimateContextComposition backward compat: no protection params = no tracking", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "skill output", [toolPart("t1", "skill")]),
    ]
    setupRefs(state, messages)

    const comp = estimateContextComposition(messages, state)
    assert.equal(comp.protectedTokens, 0, "no protection params = 0 protected")
})
