import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import type { WithParts } from "../lib/state"
import {
    buildCompressibleRanges,
    estimateContextComposition,
    formatCompressibleRanges,
} from "../lib/messages/inject/utils"
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

    const result = buildCompressibleRanges(messages, state, ["skill"])
    const allRefs = result.compressible.flatMap((r) => [r.startRef, r.endRef])
    assert.ok(
        !allRefs.some((r) => r.includes("m00003")),
        "protected message m3 excluded from compressible ranges",
    )
    assert.ok(result.compressible.length >= 1, "at least one compressible range remains")
    assert.ok(result.protected.length >= 1, "protected range tracked")
    assert.ok(result.protected[0].tools.includes("skill"), "protected range lists tool name")
})

test("buildCompressibleRanges includes all messages when no protected tools configured", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "skill output", [toolPart("t1", "skill")]),
        makeMsg("m3", "assistant", "normal text"),
    ]
    setupRefs(state, messages)

    const result = buildCompressibleRanges(messages, state, [])
    assert.ok(result.compressible.length >= 1)
    assert.ok(result.compressible[0].count >= 3, "all messages included in compressible")
    assert.equal(result.protected.length, 0, "no protected ranges when nothing protected")
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

    const result = buildCompressibleRanges(messages, state, [], ["src/**/*.ts"])
    assert.ok(
        !result.compressible.some(
            (r) => r.startRef.includes("m00002") || r.endRef.includes("m00002"),
        ),
        "protected file message excluded from compressible ranges",
    )
    assert.ok(result.protected.length >= 1, "protected range tracked")
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

test("formatCompressibleRanges merges adjacent compressible + protected into mixed line", () => {
    const state = createSessionState()
    const messages = [
        makeMsg("m1", "user", "hello"),
        makeMsg("m2", "assistant", "skill output", [toolPart("t1", "skill")]),
        makeMsg("m3", "assistant", "normal work", [toolPart("t2", "bash")]),
        makeMsg("m4", "assistant", "task output", [toolPart("t3", "task")]),
        makeMsg("m5", "assistant", "more text"),
    ]
    setupRefs(state, messages)

    const result = buildCompressibleRanges(messages, state, ["skill", "task"])
    const formatted = formatCompressibleRanges(result.compressible, result.protected)

    assert.ok(formatted.includes("compressible"), "shows compressible portion")
    assert.ok(formatted.includes("protected"), "shows protected portion")
    assert.ok(formatted.includes("skill"), "shows protected tool name")
    assert.ok(formatted.includes("task"), "shows protected tool name")
    assert.ok(
        !formatted.includes("PROTECTED: skill — not compressible]\nm"),
        "no separate protected-only line when merged",
    )
})

test("formatCompressibleRanges shows PROTECTED-only line when entire area is protected", () => {
    const state = createSessionState()
    for (let i = 1; i <= 3; i++) {
        state.messageIds.byRawId.set(`msg${i}`, `m${String(i).padStart(5, "0")}`)
    }
    const messages = [
        makeMsg("msg1", "assistant", "skill only", [toolPart("t1", "skill")]),
        makeMsg("msg2", "assistant", "task only", [toolPart("t2", "task")]),
        makeMsg("msg3", "assistant", "more skill", [toolPart("t3", "skill")]),
    ]
    setupRefs(state, messages)

    const result = buildCompressibleRanges(messages, state, ["skill", "task"])
    assert.equal(result.compressible.length, 0, "no compressible ranges")
    assert.ok(result.protected.length >= 1, "protected ranges exist")
    const formatted = formatCompressibleRanges(result.compressible, result.protected)

    assert.ok(formatted.includes("PROTECTED"), "PROTECTED label shown for pure-protected area")
    assert.ok(formatted.includes("skill"), "shows protected tool name")
    assert.ok(formatted.includes("task"), "shows protected tool name")
})
