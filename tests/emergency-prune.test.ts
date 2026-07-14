import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { runEmergencyPrune } from "../lib/messages/emergency-prune"
import { createSessionState, type WithParts } from "../lib/state"

// --- Config factory ---

function buildConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig {
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
            emergencyPruneThreshold: "95%",
            emergencyPruneTarget: "85%",
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

// --- Message/part helpers ---

const SID = "ses-emergency-prune-test"

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

function assistantMessage(
    id: string,
    parts: any[],
    created: number = 2,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts,
    }
}

const logger = new Logger(false)

// =====================================================================
// No-op cases — emergency prune should NOT fire
// =====================================================================

test("emergency prune is a no-op when below threshold", () => {
    const state = createSessionState()
    const config = buildConfig()
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(4000))]),
        userMessage("u1", "hello"),
    ]
    // 1M model, 95% threshold = 950K. currentTokens=100K < 950K
    const result = runEmergencyPrune(state, config, logger, messages, 100_000, 1_000_000)
    assert.equal(result.prunedCount, 0)
    assert.equal(result.estimatedTokensSaved, 0)
    // Verify outputs unchanged
    const toolState = (messages[0]!.parts[0] as any).state
    assert.equal(toolState.output.length, 4000)
})

test("emergency prune is a no-op when threshold is undefined", () => {
    const state = createSessionState()
    const config = buildConfig({ emergencyPruneThreshold: undefined })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(4000))]),
        userMessage("u1", "hello"),
    ]
    const result = runEmergencyPrune(state, config, logger, messages, 999_999, 1_000_000)
    assert.equal(result.prunedCount, 0)
})

test("emergency prune is a no-op when target >= currentTokens", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "50%",
        emergencyPruneTarget: "90%", // target 900K > current 600K → no reduction needed
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(4000))]),
        userMessage("u1", "hello"),
    ]
    const result = runEmergencyPrune(state, config, logger, messages, 600_000, 1_000_000)
    assert.equal(result.prunedCount, 0)
})

// =====================================================================
// Threshold resolution — number vs percentage
// =====================================================================

test("emergency prune supports numeric threshold (absolute tokens)", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: 50000,
        emergencyPruneTarget: 40000,
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(8000))]),
        userMessage("u1", "hello"),
    ]
    // current=60K >= 50K threshold, target=40K, reduction=20K
    const result = runEmergencyPrune(state, config, logger, messages, 60_000, 1_000_000)
    assert.ok(result.prunedCount > 0, "should prune at least one tool output")
    assert.ok(result.estimatedTokensSaved > 0)
})

test("emergency prune supports percentage threshold", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(8000))]),
        userMessage("u1", "hello"),
    ]
    // 1M model, 10% threshold = 100K. current=150K >= 100K
    // target = 50K, reduction = 100K
    const result = runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)
    assert.ok(result.prunedCount > 0, "should prune when above percentage threshold")
})

// =====================================================================
// Pruning behavior — priority, ordering, target reduction
// =====================================================================

test("emergency prune stubs oldest tool outputs first (priority ordering)", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "OLD_OUTPUT_FIRST")]),
        assistantMessage("a2", [toolPart("c2", "bash", "NEW_OUTPUT_SECOND")]),
        userMessage("u1", "hello"),
    ]
    // 1M model: threshold=100K, target=50K, current=150K, reduction=100K
    // Each output ~13 chars ≈ 4 tokens. Both will be pruned to reach 100K reduction.
    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    const firstOutput = (messages[0]!.parts[0] as any).state.output
    const secondOutput = (messages[1]!.parts[0] as any).state.output
    assert.equal(firstOutput, "[Output emergency-pruned to prevent context overflow]")
    assert.equal(secondOutput, "[Output emergency-pruned to prevent context overflow]")
})

test("emergency prune stops when target reduction is reached", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "9.9%", // small reduction needed
    })
    // Create a large first output and a small second output
    const largeOutput = "x".repeat(4000) // ~1000 tokens
    const smallOutput = "y".repeat(40) // ~10 tokens
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", largeOutput)]),
        assistantMessage("a2", [toolPart("c2", "bash", smallOutput)]),
        userMessage("u1", "hello"),
    ]
    // 1M model: threshold=100K, target=99K, current=100K, reduction=1K
    // First output (~1000 tokens) exceeds the 1K reduction → only first pruned
    const result = runEmergencyPrune(state, config, logger, messages, 100_000, 1_000_000)
    assert.equal(result.prunedCount, 1, "only first output should be pruned")
    const firstOutput = (messages[0]!.parts[0] as any).state.output
    const secondOutput = (messages[1]!.parts[0] as any).state.output
    assert.equal(firstOutput, "[Output emergency-pruned to prevent context overflow]")
    assert.equal(secondOutput, smallOutput, "second output should be untouched")
})

test("emergency prune does NOT prune messages at or after last user message", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "OLD")]),
        userMessage("u1", "question"),
        assistantMessage("a2", [toolPart("c2", "bash", "AFTER_USER")]),
    ]
    // lastUserIdx = 1 (u1). Loop breaks at i >= 1. Only a1 (i=0) is eligible.
    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    const beforeUserOutput = (messages[0]!.parts[0] as any).state.output
    const afterUserOutput = (messages[2]!.parts[0] as any).state.output
    assert.equal(beforeUserOutput, "[Output emergency-pruned to prevent context overflow]")
    assert.equal(afterUserOutput, "AFTER_USER", "output after last user message should be preserved")
})

// =====================================================================
// Protected tool skipping
// =====================================================================

test("emergency prune skips protected tool outputs", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
        protectedTools: ["skill"],
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "skill", "PROTECTED_OUTPUT")]),
        assistantMessage("a2", [toolPart("c2", "bash", "PRUNABLE_OUTPUT")]),
        userMessage("u1", "hello"),
    ]
    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    const protectedOutput = (messages[0]!.parts[0] as any).state.output
    const prunableOutput = (messages[1]!.parts[0] as any).state.output
    assert.equal(protectedOutput, "PROTECTED_OUTPUT", "protected tool output should be preserved")
    assert.equal(prunableOutput, "[Output emergency-pruned to prevent context overflow]")
})

// =====================================================================
// Idempotency — already-stubbed outputs are skipped
// =====================================================================

test("emergency prune is idempotent — skips already-stubbed outputs", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const stub = "[Output emergency-pruned to prevent context overflow]"
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", stub)]),
        assistantMessage("a2", [toolPart("c2", "bash", "x".repeat(4000))]),
        userMessage("u1", "hello"),
    ]
    // First output is already stubbed → should be skipped, only second pruned
    const result = runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)
    assert.equal(result.prunedCount, 1, "should skip already-stubbed output")
    const firstOutput = (messages[0]!.parts[0] as any).state.output
    const secondOutput = (messages[1]!.parts[0] as any).state.output
    assert.equal(firstOutput, stub)
    assert.equal(secondOutput, stub)
})

// =====================================================================
// Edge cases
// =====================================================================

test("emergency prune skips non-completed tool parts", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [
            toolPart("c1", "bash", "RUNNING_OUTPUT", "error"),
            toolPart("c2", "bash", "COMPLETED_OUTPUT"),
        ]),
        userMessage("u1", "hello"),
    ]
    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    const errorOutput = (messages[0]!.parts[0] as any).state.output
    const completedOutput = (messages[0]!.parts[1] as any).state.output
    assert.equal(errorOutput, "RUNNING_OUTPUT", "error status tool should be skipped")
    assert.equal(completedOutput, "[Output emergency-pruned to prevent context overflow]")
})

test("emergency prune skips empty tool outputs", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [
            toolPart("c1", "bash", ""),
            toolPart("c2", "bash", "NON_EMPTY"),
        ]),
        userMessage("u1", "hello"),
    ]
    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    const emptyOutput = (messages[0]!.parts[0] as any).state.output
    const nonEmptyOutput = (messages[0]!.parts[1] as any).state.output
    assert.equal(emptyOutput, "", "empty output should be skipped")
    assert.equal(nonEmptyOutput, "[Output emergency-pruned to prevent context overflow]")
})

test("emergency prune does nothing when no user message exists", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", "x".repeat(4000))]),
        assistantMessage("a2", [toolPart("c2", "bash", "y".repeat(4000))]),
    ]
    // No user message → findLastIndex returns -1 → loop breaks immediately
    const result = runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)
    assert.equal(result.prunedCount, 0)
    // Outputs unchanged
    assert.equal((messages[0]!.parts[0] as any).state.output.length, 4000)
    assert.equal((messages[1]!.parts[0] as any).state.output.length, 4000)
})

test("emergency prune handles multiple tool parts in single message", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const messages = [
        assistantMessage("a1", [
            toolPart("c1", "bash", "x".repeat(4000)),
            toolPart("c2", "bash", "y".repeat(4000)),
            toolPart("c3", "bash", "z".repeat(4000)),
        ]),
        userMessage("u1", "hello"),
    ]
    // 1M model: threshold=100K, target=50K, reduction=100K
    // Each output ~1000 tokens. Need ~100 tool prunes for 100K, but only 3 available.
    const result = runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)
    assert.equal(result.prunedCount, 3, "all 3 tool parts should be pruned")
    for (let i = 0; i < 3; i++) {
        const output = (messages[0]!.parts[i] as any).state.output
        assert.equal(output, "[Output emergency-pruned to prevent context overflow]")
    }
})

test("emergency prune mutates output in-place (ephemeral, no state persistence)", () => {
    const state = createSessionState()
    const config = buildConfig({
        emergencyPruneThreshold: "10%",
        emergencyPruneTarget: "5%",
    })
    const originalOutput = "x".repeat(4000)
    const messages = [
        assistantMessage("a1", [toolPart("c1", "bash", originalOutput)]),
        userMessage("u1", "hello"),
    ]
    const originalStateSnapshot = JSON.stringify({
        prune: state.prune,
        nudges: state.nudges,
    })

    runEmergencyPrune(state, config, logger, messages, 150_000, 1_000_000)

    // State should be unchanged (ephemeral pruning)
    const postStateSnapshot = JSON.stringify({
        prune: state.prune,
        nudges: state.nudges,
    })
    assert.equal(originalStateSnapshot, postStateSnapshot, "state should not be mutated")
    // But message output should be stubbed
    assert.notEqual((messages[0]!.parts[0] as any).state.output, originalOutput)
})
