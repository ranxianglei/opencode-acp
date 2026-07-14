import assert from "node:assert/strict"
import test from "node:test"
import { resolveKeepMarkers } from "../lib/compress/keep-markers"
import { buildCompressibleRanges, formatCompressibleRanges } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function mkMsg(id: string, role: "user" | "assistant", parts: any[]): WithParts {
    return {
        info: { id, role, sessionID: "s", agent: "a", time: { created: 1 } } as any,
        parts,
    }
}

function textPart(id: string, text: string) {
    return { id: `${id}-p`, messageID: id, sessionID: "s", type: "text" as const, text }
}

function toolPart(callID: string, tool: string, output: string, input: any = {}) {
    return {
        id: `p-${callID}`,
        messageID: "m",
        sessionID: "s",
        type: "tool" as const,
        tool,
        callID,
        state: { status: "completed" as const, output, input },
    }
}

function compressPart(callID: string, summary: string) {
    return {
        id: `p-${callID}`,
        messageID: "m",
        sessionID: "s",
        type: "tool" as const,
        tool: "compress",
        callID,
        state: {
            status: "completed" as const,
            output: "Compressed 2 messages into [BLOCK b0].",
            input: { topic: "test", content: [{ startId: "m1", endId: "m2", summary }] },
        },
    }
}

test("resolveKeepMarkers: expands [[KEEP:mNNNNN]] with formatted content", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    state.messageIds.byRawId.set("msg2", "m00002")
    const config = buildConfig()
    const messages: WithParts[] = [
        mkMsg("msg1", "assistant", [toolPart("c1", "bash", "test output")]),
        mkMsg("msg2", "assistant", [textPart("msg2", "important text")]),
    ]
    const summary = "Did work. [[KEEP:m00001]] Then more. [[KEEP:m00002]]"
    const result = resolveKeepMarkers(summary, messages, state, config)

    assert.equal(result.expandedCount, 2)
    assert.ok(result.summary.includes("test output"), "KEEP must expand bash output")
    assert.ok(result.summary.includes("important text"), "KEEP must expand text content")
    assert.ok(result.summary.includes("[m00001:"), "KEEP must label with ref")
    assert.ok(result.summary.includes("[m00002:"), "KEEP must label with ref")
})

test("resolveKeepMarkers: converts [[REF:mNNNNN|desc]] to compact link", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    const config = buildConfig()
    const messages: WithParts[] = [mkMsg("msg1", "assistant", [toolPart("c1", "bash", "result")])]
    const summary = "See [[REF:m00001|test results]] for details."
    const result = resolveKeepMarkers(summary, messages, state, config)

    assert.equal(result.refCount, 1)
    assert.ok(result.summary.includes("[→ m00001: test results]"), "REF must become compact link")
    assert.ok(!result.summary.includes("$ undefined"), "REF must NOT expand the bash command")
})

test("resolveKeepMarkers: leaves unresolved markers intact", () => {
    const state = createSessionState()
    const config = buildConfig()
    const messages: WithParts[] = []
    const summary = "[[KEEP:m99999]] and [[REF:m99998|missing]]"
    const result = resolveKeepMarkers(summary, messages, state, config)

    assert.equal(result.expandedCount, 0)
    assert.equal(result.refCount, 0)
    assert.deepEqual(result.unresolvedRefs, ["m99999", "m99998"])
    assert.ok(summary.includes("[[KEEP:m99999]]"), "unresolved KEEP stays as-is")
})

test("resolveKeepMarkers: truncates long content to keepEmbedMaxChars", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    const config = buildConfig()
    config.compress.keepEmbedMaxChars = 100
    const longOutput = "x".repeat(500)
    const messages: WithParts[] = [mkMsg("msg1", "assistant", [toolPart("c1", "bash", longOutput)])]
    const summary = "[[KEEP:m00001]]"
    const result = resolveKeepMarkers(summary, messages, state, config)

    assert.ok(result.summary.includes("[truncated"), "must indicate truncation")
    assert.ok(/chars total/.test(result.summary), "must show original length")
})

test("resolveKeepMarkers: formats bash as $ command + output", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    const config = buildConfig()
    const messages: WithParts[] = [
        mkMsg("msg1", "assistant", [toolPart("c1", "bash", "pass", { command: "npm test" })]),
    ]
    const result = resolveKeepMarkers("[[KEEP:m00001]]", messages, state, config)
    assert.ok(result.summary.includes("$ npm test"), "bash must show command with $ prefix")
    assert.ok(result.summary.includes("pass"), "bash must show output")
})

test("buildCompressibleRanges: groups by conversation turns", () => {
    const state = createSessionState()
    for (let i = 1; i <= 10; i++) {
        state.messageIds.byRawId.set(`msg${i}`, `m${String(i).padStart(5, "0")}`)
    }
    const messages: WithParts[] = [
        mkMsg("msg1", "user", [textPart("msg1", "hello")]),
        mkMsg("msg2", "assistant", [
            textPart("msg2", "hi"),
            toolPart("c1", "bash", "x".repeat(100)),
        ]),
        mkMsg("msg3", "assistant", [textPart("msg3", "done")]),
        mkMsg("msg4", "user", [textPart("msg4", "next")]),
        mkMsg("msg5", "assistant", [
            textPart("msg5", "result"),
            toolPart("c2", "bash", "y".repeat(100)),
        ]),
        mkMsg("msg6", "assistant", [textPart("msg6", "finished")]),
    ]
    const result = buildCompressibleRanges(messages, state)
    const ranges = result.compressible
    assert.ok(ranges.length >= 1, "should produce at least 1 range")
    assert.ok(ranges[0].count >= 3, "first range should contain multiple messages")
    assert.ok(ranges[0].tokens > 0, "range should have positive token count")
})

test("formatCompressibleRanges: produces formatted output", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    state.messageIds.byRawId.set("msg2", "m00002")
    state.messageIds.byRawId.set("msg3", "m00003")
    const messages: WithParts[] = [
        mkMsg("msg1", "user", [textPart("msg1", "hello")]),
        mkMsg("msg2", "assistant", [
            textPart("msg2", "response"),
            toolPart("c1", "bash", "x".repeat(200)),
        ]),
        mkMsg("msg3", "assistant", [textPart("msg3", "done")]),
    ]
    const result = buildCompressibleRanges(messages, state)
    const formatted = formatCompressibleRanges(result.compressible)
    assert.ok(formatted.includes("Compressible ranges"), "must have header")
    assert.ok(formatted.includes("m00001"), "must show start ref")
})

test("buildCompressibleRanges excludes compress tool call messages (compress-as-anchor)", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("msg1", "m00001")
    state.messageIds.byRawId.set("msg2", "m00002")
    state.messageIds.byRawId.set("msg3", "m00003")
    const messages: WithParts[] = [
        mkMsg("msg1", "user", [textPart("msg1", "hello")]),
        mkMsg("msg2", "assistant", [compressPart("c-comp", "compressed summary text")]),
        mkMsg("msg3", "assistant", [textPart("msg3", "done")]),
    ]
    const result = buildCompressibleRanges(messages, state)
    const compressibleRefs = result.compressible.flatMap((r) => [r.startRef, r.endRef])
    assert.ok(
        !compressibleRefs.includes("m00002"),
        "compress tool call (m00002) must NOT appear in compressible ranges",
    )
    assert.ok(
        compressibleRefs.includes("m00001") || compressibleRefs.includes("m00003"),
        "non-compress messages should still be compressible",
    )
})
