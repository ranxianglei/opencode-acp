import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"
import { createSessionState, type WithParts, type CompressionBlock } from "../lib/state"

// --- Config factory ---

function buildConfig(mode: "message" | "range" = "range"): PluginConfig {
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
            mode,
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
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

// --- Message/part helpers ---

const SID = "ses-prune-test"

function textPart(msgId: string, id: string, text: string) {
    return { id, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function toolPart(
    callID: string,
    toolName: string,
    output: string,
    status: "completed" | "error" = "completed",
    input?: Record<string, unknown>,
) {
    return {
        id: `${callID}-part`,
        messageID: `msg-${callID}`,
        sessionID: SID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status,
            input: input ?? { description: "demo" },
            output,
        },
    }
}

function userMessage(id: string, text: string, created: number = 1): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, `${id}-p1`, text)],
    }
}

function assistantMessage(id: string, created: number = 2, parts?: any[]): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: parts ?? [textPart(id, `${id}-p1`, "assistant text")],
    }
}

const logger = new Logger(false)

// =====================================================================
// filterCompressedRanges — core compression range replacement
// =====================================================================

test("prune is a no-op when no compression blocks exist", () => {
    const state = createSessionState()
    const messages: WithParts[] = [userMessage("u1", "hello"), assistantMessage("a1")]
    const original = [...messages]
    prune(state, logger, buildConfig(), messages)
    assert.equal(messages.length, original.length)
    assert.deepEqual(messages.map((m) => m.info.id), ["u1", "a1"])
})

test("prune removes messages in active compression ranges", () => {
    const state = createSessionState()
    // Mark messages m2, m3 as pruned by block 1
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.byMessageId.set("m3", { tokenCount: 200, allBlockIds: [1], activeBlockIds: [1] })
    // Block 1 anchored at m1
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2", "m3"],
        effectiveMessageIds: ["m2", "m3"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "test topic",
        summary: "Summary of m2-m3",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("m1", "user question"),
        assistantMessage("m2", 2),
        assistantMessage("m3", 3),
        userMessage("m4", "follow up", 4),
    ]

    prune(state, logger, buildConfig(), messages)

    // m2, m3 should be removed; summary should be injected as tool-result at m1 anchor
    const ids = messages.map((m) => m.info.id)
    assert.ok(!ids.includes("m2"), "m2 should be pruned")
    assert.ok(!ids.includes("m3"), "m3 should be pruned")
    assert.ok(ids.includes("m1"), "anchor m1 should survive")
    assert.ok(ids.includes("m4"), "m4 should survive")
    const recapMsg = messages.find((m) =>
        m.info.role === "assistant" &&
        m.parts.some((p: any) => p.type === "tool" && p.tool === "acp_context_recap" && p.state?.output?.includes("Summary of m2-m3")),
    )
    assert.ok(recapMsg, "summary should be injected as acp_context_recap tool-result")
})

test("prune injects summary as tool-result regardless of next surviving message role", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "merged topic",
        summary: "Merged summary text",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("m1", "first question", 1),
        assistantMessage("m2", 2),
        userMessage("m3", "second question", 3),
    ]

    prune(state, logger, buildConfig(), messages)

    const ids = messages.map((m) => m.info.id)
    assert.ok(!ids.includes("m2"), "m2 should be pruned")

    // Summary should be injected as a tool-result recap, NOT merged into any user message
    const m1 = messages.find((m) => m.info.id === "m1")
    assert.ok(m1, "m1 (anchor) should survive")
    const m1Text = m1!.parts.map((p: any) => p.text ?? "").join("")
    assert.ok(!m1Text.includes("Merged summary text"), "summary should NOT be merged into anchor m1")
    assert.ok(m1Text.includes("first question"), "original m1 text should be preserved")

    const recapMsg = messages.find((m) =>
        m.info.role === "assistant" &&
        m.parts.some((p: any) => p.type === "tool" && p.tool === "acp_context_recap" && p.state?.output?.includes("Merged summary text")),
    )
    assert.ok(recapMsg, "summary should be injected as tool-result recap")
})

test("prune injects tool-result recap when anchor is assistant and no user follows", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("a1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "a1",
        topic: "standalone",
        summary: "Standalone summary",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("u1", "question", 1),
        assistantMessage("a1", 2),
        assistantMessage("m2", 3),
        assistantMessage("a2", 4),
    ]

    prune(state, logger, buildConfig(), messages)

    const recapMsg = messages.find((m) =>
        m.info.role === "assistant" &&
        m.parts.some((p: any) => p.type === "tool" && p.tool === "acp_context_recap" && p.state?.output?.includes("Standalone summary")),
    )
    assert.ok(recapMsg, "summary should be injected as tool-result recap regardless of anchor role")
})

test("prune skips inactive compression blocks", () => {
    const state = createSessionState()
    // Block is inactive
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [] })
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: false,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "inactive",
        summary: "Should not appear",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("m1", "q", 1),
        assistantMessage("m2", 2),
    ]

    prune(state, logger, buildConfig(), messages)

    // m2 has activeBlockIds: [] so it should survive (not pruned)
    const ids = messages.map((m) => m.info.id)
    assert.ok(ids.includes("m2"), "m2 should survive (block is inactive)")
    // No summary should be injected because the block is inactive
    const hasSummary = messages.some((m) =>
        m.parts.some((p: any) => p.text?.includes("Should not appear")),
    )
    assert.ok(!hasSummary, "inactive block summary should not be injected")
})

test("prune strips stale mNNNN refs from summary content (Bug 28 fix)", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "stale refs",
        summary: "Summary with <dcp-message-id>m00999</dcp-message-id> stale ref",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("m1", "q", 1),
        assistantMessage("m2", 2),
        userMessage("m3", "follow", 3),
    ]

    prune(state, logger, buildConfig(), messages)

    const recapMsg = messages.find((m) =>
        m.parts.some((p: any) => p.type === "tool" && p.tool === "acp_context_recap"),
    )
    assert.ok(recapMsg, "recap tool-result should be injected")
    const output = (recapMsg!.parts.find((p: any) => p.type === "tool") as any)?.state?.output ?? ""
    assert.ok(!output.includes("</dcp-message-id>"), "stale dcp-message-id tag should be stripped")
    assert.ok(output.includes("Summary with"), "summary content should remain after stripping")
})

// =====================================================================
// pruneToolOutputs — completed tool output replacement
// =====================================================================

test("prune preserves completed tool outputs (prefix cache fix)", () => {
    const state = createSessionState()
    state.prune.tools.set("call-1", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-1", "bash", "long output that should be preserved"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(
        part.state.output,
        "long output that should be preserved",
    )
})

test("prune does not replace question/edit/write tool outputs", () => {
    const state = createSessionState()
    state.prune.tools.set("call-q", 1)
    state.prune.tools.set("call-edit", 1)
    state.prune.tools.set("call-write", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-q", "question", "question output"),
            toolPart("call-edit", "edit", "edit output"),
            toolPart("call-write", "write", "write output"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const parts = messages[0]!.parts as any[]
    assert.equal(parts[0]!.state.output, "question output", "question output should NOT be replaced")
    assert.equal(parts[1]!.state.output, "edit output", "edit output should NOT be replaced")
    assert.equal(parts[2]!.state.output, "write output", "write output should NOT be replaced")
})

test("prune does not replace tool outputs for tools not in prune set", () => {
    const state = createSessionState()
    // call-1 is NOT in prune set

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-1", "bash", "should remain"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.output, "should remain")
})

test("prune does not replace outputs for error-status tools", () => {
    const state = createSessionState()
    state.prune.tools.set("call-err", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-err", "bash", "error output", "error"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    // Error status tools are handled by pruneToolErrors, not pruneToolOutputs
    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.output, "error output", "error tool output should NOT be replaced by pruneToolOutputs")
})

// =====================================================================
// pruneToolInputs — question tool input replacement
// =====================================================================

test("prune preserves question tool inputs (prefix cache fix)", () => {
    const state = createSessionState()
    state.prune.tools.set("call-q", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-q", "question", "output", "completed", {
                questions: "What color do you prefer?",
            }),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(
        part.state.input.questions,
        "What color do you prefer?",
    )
})

test("prune does not replace question input for non-question tools", () => {
    const state = createSessionState()
    state.prune.tools.set("call-bash", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-bash", "bash", "output", "completed", {
                command: "ls -la",
            }),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.input.command, "ls -la", "non-question tool input should NOT be replaced")
})

// =====================================================================
// pruneToolErrors — error tool input replacement
// =====================================================================

test("prune preserves error tool inputs (prefix cache fix)", () => {
    const state = createSessionState()
    state.prune.tools.set("call-err", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-err", "bash", "error output", "error", {
                command: "rm -rf /",
                description: "dangerous command",
                count: 5,
            }),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.input.command, "rm -rf /")
    assert.equal(part.state.input.description, "dangerous command")
    assert.equal(part.state.input.count, 5)
})

test("prune does not replace inputs for completed tools in error pruning", () => {
    const state = createSessionState()
    state.prune.tools.set("call-ok", 1)

    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            toolPart("call-ok", "bash", "success output", "completed", {
                command: "echo hello",
            }),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.input.command, "echo hello", "completed tool input should NOT be replaced by error pruning")
})

// =====================================================================
// Combined behavior
// =====================================================================

test("prune handles mixed scenario: compressed range + tool output pruning", () => {
    const state = createSessionState()
    // Block 1 prunes m2
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "combined",
        summary: "Combined summary",
    } as CompressionBlock)
    // Also prune a tool output in m3
    state.prune.tools.set("call-tool3", 1)

    const messages: WithParts[] = [
        userMessage("m1", "question", 1),
        assistantMessage("m2", 2),
        assistantMessage("m3", 3, [
            toolPart("call-tool3", "bash", "output to be pruned"),
            textPart("m3", "m3-text", "surviving text"),
        ]),
        userMessage("m4", "follow up", 4),
    ]

    prune(state, logger, buildConfig(), messages)

    const ids = messages.map((m) => m.info.id)
    assert.ok(!ids.includes("m2"), "m2 should be pruned by compression range")

    // m3's tool output should be preserved (prefix cache fix)
    const m3 = messages.find((m) => m.info.id === "m3")
    assert.ok(m3, "m3 should survive")
    const toolPartResult = m3!.parts.find((p: any) => p.type === "tool") as any
    assert.equal(
        toolPartResult.state.output,
        "output to be pruned",
        "m3 tool output should be preserved (prefix cache fix)",
    )
})

test("prune preserves message order for surviving messages", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("m1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 300,
        summaryTokens: 50,
        durationMs: 100,
        generation: "young",
        survivedCount: 0,
        directMessageIds: ["m2"],
        effectiveMessageIds: ["m2"],
        directToolIds: [],
        effectiveToolIds: [],
        anchorMessageId: "m1",
        topic: "order",
        summary: "Order test summary",
    } as CompressionBlock)

    const messages: WithParts[] = [
        userMessage("m1", "first", 1),
        assistantMessage("m2", 2),
        assistantMessage("m3", 3),
        userMessage("m4", "second", 4),
    ]

    prune(state, logger, buildConfig(), messages)

    const ids = messages.map((m) => m.info.id)
    // m1 should come before m3/m4
    const m1Idx = ids.indexOf("m1")
    const m3Idx = ids.indexOf("m3")
    const m4Idx = ids.indexOf("m4")
    assert.ok(m1Idx >= 0 && m3Idx >= 0 && m4Idx >= 0, "all surviving messages should be present")
    assert.ok(m1Idx < m3Idx, "m1 should come before m3")
    assert.ok(m3Idx < m4Idx, "m3 should come before m4")
})

// =====================================================================
// stripStepMarkers — step-start removal + step-finish truncation
// =====================================================================

function stepStartPart(msgId: string, id: string) {
    return { id, messageID: msgId, sessionID: SID, type: "step-start" as const }
}

function stepFinishPart(msgId: string, id: string, reason: string) {
    return { id, messageID: msgId, sessionID: SID, type: "step-finish" as const, reason }
}

test("stripStepMarkers removes step-start parts entirely", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            stepStartPart("a1", "a1-ss"),
            textPart("a1", "a1-t", "real content"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const types = messages[0]!.parts.map((p: any) => p.type)
    assert.ok(!types.includes("step-start"), "step-start should be removed")
    assert.ok(types.includes("text"), "text part should remain")
})

test("stripStepMarkers truncates long step-finish reason to 50 chars", () => {
    const state = createSessionState()
    const longReason = "x".repeat(155)
    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            stepFinishPart("a1", "a1-sf", longReason),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const sf = messages[0]!.parts.find((p: any) => p.type === "step-finish") as any
    assert.ok(sf, "step-finish part should remain")
    assert.equal(sf.reason.length, 53, "reason should be 50 chars + '...'")
    assert.ok(sf.reason.endsWith("..."), "truncated reason should end with '...'")
})

test("stripStepMarkers preserves short step-finish reason unchanged", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            stepFinishPart("a1", "a1-sf", "short reason"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)

    const sf = messages[0]!.parts.find((p: any) => p.type === "step-finish") as any
    assert.equal(sf.reason, "short reason", "short reason should be preserved")
})

test("stripStepMarkers is idempotent: second run keeps parts reference stable", () => {
    const state = createSessionState()
    const longReason = "y".repeat(120)
    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            stepStartPart("a1", "a1-ss"),
            stepFinishPart("a1", "a1-sf", longReason),
            textPart("a1", "a1-t", "keep me"),
        ]),
    ]

    prune(state, logger, buildConfig(), messages)
    const partsRefAfterFirst = messages[0]!.parts
    const reasonAfterFirst = (partsRefAfterFirst.find((p: any) => p.type === "step-finish") as any).reason

    // Second pass over already-stripped messages
    prune(state, logger, buildConfig(), messages)

    // Prefix-cache invariant: parts array must NOT be reassigned on idempotent re-run
    assert.equal(
        messages[0]!.parts,
        partsRefAfterFirst,
        "parts array reference must stay stable on idempotent re-run (prefix cache)",
    )
    const reasonAfterSecond = (messages[0]!.parts.find((p: any) => p.type === "step-finish") as any).reason
    assert.equal(reasonAfterSecond, reasonAfterFirst, "reason must be byte-identical on re-run")
})

test("stripStepMarkers leaves messages without step markers untouched", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        assistantMessage("a1", 1, [
            textPart("a1", "a1-t", "plain text only"),
            toolPart("call-1", "bash", "output"),
        ]),
    ]
    const originalParts = messages[0]!.parts

    prune(state, logger, buildConfig(), messages)

    assert.equal(
        messages[0]!.parts,
        originalParts,
        "parts array reference unchanged when no step markers present",
    )
})
