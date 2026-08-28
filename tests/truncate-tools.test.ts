import assert from "node:assert/strict"
import test from "node:test"

import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"
import { truncateLargeToolOutputs } from "../lib/messages/truncate-tools"

const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger

function makeConfig(gc?: Partial<PluginConfig["gc"]>): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
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
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
            ...gc,
        },
    } as unknown as PluginConfig
}

function makeState(modelContextLimit: number = 200000): SessionState {
    return {
        sessionId: "session-1",
        isSubAgent: false,
        modelContextLimit,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map(),
                blocksById: new Map(),
                activeBlockIds: new Set(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
                nextRunId: 1,
                markedForCleanup: new Set(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            baselineLocked: false,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        compressionTiming: { pending: new Map(), completed: [] },
        toolParameters: new Map(),
    } as unknown as SessionState
}

function makeToolMessage(
    id: string,
    output: string,
    status: "completed" | "error" = "completed",
): WithParts {
    return {
        info: {
            id,
            role: "tool",
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [
            {
                type: "tool",
                toolName: "bash",
                state: {
                    status,
                    output,
                    input: {},
                    time: {},
                },
            },
        ] as any,
    }
}

function makeTextMessage(id: string, text: string, role: "user" | "assistant" = "user"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeAssistantWithTokens(id: string, inputTokens: number, text = "ok"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
            tokens: { input: inputTokens, output: 100 },
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

const LARGE_OUTPUT = "x".repeat(50000)
// [FIX #346] Smaller fixture for the new tests: 2201 tokens (comfortably
// above MIN_OUTPUT_TOKENS) but ~5x less tokenization work per message.
const MEDIUM_OUTPUT = "The quick brown fox jumps over the lazy dog. ".repeat(220)

test("Truncation: does nothing when context is below threshold", () => {
    const state = makeState(200000)
    const config = makeConfig({ majorGcThresholdPercent: "100%" })
    const messages = [
        makeToolMessage("msg-1", LARGE_OUTPUT),
        makeTextMessage("msg-2", "hello"),
        makeTextMessage("msg-3", "world", "assistant"),
    ]

    const original = (messages[0]!.parts[0] as any).state.output
    truncateLargeToolOutputs(state, config, noopLogger, messages)
    const after = (messages[0]!.parts[0] as any).state.output

    assert.equal(after, original, "Tool output should not be modified below threshold")
})

test("Truncation: truncates largest tool output at threshold", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) for the
    // overhead-aware threshold to be positive.
    const state = makeState(200000)
    const config = makeConfig({ majorGcThresholdPercent: "100%" })

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, LARGE_OUTPUT))
    }
    messages.push(makeTextMessage("msg-user", "hello"))
    // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
    // (= min(200_000, 200_000 − 16_384 output reserve))
    messages.push(makeAssistantWithTokens("msg-asst", 200_000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let truncatedCount = 0
    for (let i = 0; i < 10; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        if (output.includes("[truncated for context space")) {
            truncatedCount++
            assert.ok(
                output.length < LARGE_OUTPUT.length,
                `msg-${i} should be shorter after truncation`,
            )
        }
    }
    assert.ok(truncatedCount > 0, "At least one tool output should be truncated")
})

test("Truncation: NEVER touches text messages or summaries", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive and truncation actually runs.
    const state = makeState(200_000)
    const config = makeConfig()

    const messages: WithParts[] = [
        makeToolMessage("msg-1", LARGE_OUTPUT),
        makeTextMessage("msg-2", "important summary text that must survive"),
        makeAssistantWithTokens("msg-3", 200_000, "another text message"),
        makeTextMessage("msg-4", "user message"),
        makeAssistantWithTokens("msg-5", 200_000, "final"),
    ]

    const originalTexts = messages.slice(1).map((m) => (m.parts[0] as any).text)

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 1; i < messages.length; i++) {
        const text = (messages[i]!.parts[0] as any).text
        assert.equal(text, originalTexts[i - 1], `Text message ${i} must not be modified`)
    }
})

test("Truncation: protects last 3 messages", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive and truncation actually runs.
    const state = makeState(200_000)
    const config = makeConfig()

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, LARGE_OUTPUT))
    }
    // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
    messages.push(makeAssistantWithTokens("msg-asst", 200_000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    const protectedStart = messages.length - 3
    for (let i = protectedStart; i < messages.length; i++) {
        const part = messages[i]!.parts[0] as any
        if (part?.type !== "tool") continue
        const output = part.state?.output
        assert.equal(
            output,
            LARGE_OUTPUT,
            `msg-${i} (last ${messages.length - i}) should be protected`,
        )
    }
})

test("Truncation: skips already-truncated outputs", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive and truncation actually runs.
    const state = makeState(200_000)
    const config = makeConfig()

    const alreadyTruncated =
        "prefix data\n\n...[truncated for context space — original ~5000 tokens]...\n\nsuffix data"
    const messages: WithParts[] = [
        makeToolMessage("msg-1", alreadyTruncated),
        makeToolMessage("msg-2", LARGE_OUTPUT),
        makeToolMessage("msg-3", LARGE_OUTPUT),
        makeToolMessage("msg-4", "small"),
        makeToolMessage("msg-5", "small"),
        // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
        makeAssistantWithTokens("msg-asst", 200_000),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    const output0 = (messages[0]!.parts[0] as any).state.output
    assert.equal(output0, alreadyTruncated, "Already-truncated output should not be re-truncated")
})

test("Truncation: skips small tool outputs", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive and truncation actually runs.
    // A large output is included so the MIN_OUTPUT_TOKENS filter is
    // exercised against real truncation, not a no-op.
    const state = makeState(200_000)
    const config = makeConfig()

    const smallOutput = "small result"
    const messages: WithParts[] = [
        makeToolMessage("msg-1", LARGE_OUTPUT),
        makeToolMessage("msg-2", smallOutput),
        makeToolMessage("msg-3", smallOutput),
        makeToolMessage("msg-4", smallOutput),
        makeToolMessage("msg-5", smallOutput),
        makeToolMessage("msg-6", smallOutput),
        // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
        makeAssistantWithTokens("msg-asst", 200_000),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 1; i < messages.length - 1; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        assert.equal(output, smallOutput, `Small output ${i} should not be truncated`)
    }
    const largeOutput = (messages[0]!.parts[0] as any).state.output
    assert.ok(
        largeOutput.includes("[truncated for context space"),
        "the large output should have been truncated",
    )
})

test("Truncation: no crash on empty messages", () => {
    const state = makeState(200_000)
    const config = makeConfig()

    truncateLargeToolOutputs(state, config, noopLogger, [])
})

test("Truncation: no crash when no tool outputs exist", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384): a tiny
    // window would trip the once-per-session overhead ERROR here and mask
    // the "window too small" test's assertion later in this file.
    const state = makeState(200_000)
    const config = makeConfig()

    const messages: WithParts[] = [
        makeTextMessage("msg-1", "text"),
        makeTextMessage("msg-2", "text", "assistant"),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)
})

test("Truncation: preserves prefix and suffix of truncated output", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive.
    const state = makeState(200000)
    const config = makeConfig()

    const prefix = "START_MARKER_" + "p".repeat(2000)
    const middle = "m".repeat(45000)
    const suffix = "s".repeat(2000) + "_END_MARKER"
    const fullOutput = prefix + middle + suffix

    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) {
        messages.push(makeToolMessage(`msg-${i}`, fullOutput))
    }
    messages.push(makeTextMessage("msg-6", "text"))
    // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
    // (= min(200_000, 200_000 − 16_384 output reserve))
    messages.push(makeAssistantWithTokens("msg-7", 200_000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let foundTruncated = false
    for (let i = 0; i < 5; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        if (output.includes("[truncated for context space")) {
            foundTruncated = true
            assert.ok(output.startsWith("START_MARKER_"), "Prefix should be preserved")
            assert.ok(output.endsWith("_END_MARKER"), "Suffix should be preserved")
            assert.ok(output.includes("[truncated"), "Truncation marker should be present")
        }
    }
    assert.ok(foundTruncated, "At least one output should have been truncated")
})

test("Truncation equivalence: output never longer than input", () => {
    // [FIX #346] Window must exceed OUTPUT_RESERVE_TOKENS (16384) so the
    // overhead-aware threshold stays positive and truncation actually runs.
    const state = makeState(200_000)
    const config = makeConfig()

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, "x".repeat(50000)))
    }
    messages.push(makeTextMessage("msg-11", "text"))
    // [FIX #346] 200_000 + output 100 = 200_100 ≥ threshold 183_616
    messages.push(makeAssistantWithTokens("msg-12", 200_000))

    const originalLengths = messages.map((m) => {
        const part = m.parts[0] as any
        return part?.state?.output?.length ?? part?.text?.length ?? 0
    })

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 0; i < messages.length; i++) {
        const part = messages[i]!.parts[0] as any
        const newLength = part?.state?.output?.length ?? part?.text?.length ?? 0
        assert.ok(
            newLength <= originalLengths[i],
            `Message ${i}: new length ${newLength} must not exceed original ${originalLengths[i]}`,
        )
    }
})

// ─── Issue #346: the serving wall is window − system prompt − max_tokens ─────

test("production wall repro (#346): truncates when conversation + overhead exceeds the window", () => {
    // Production numbers from the issue: 229_479 conversation tokens on a
    // 262_144 window with ~17k system prompt + 16_384 max_tokens. The old
    // 100%-of-window threshold started truncating only at 262_144 — AFTER the
    // request had already exceeded max_model_len (immediate rejection, silent
    // empty run, retry loop). The overhead-aware threshold is
    // min(262_144, 262_144 − 17_000 − 16_384) = 228_760 ≤ 229_479 → must fire.
    const state = makeState(262_144)
    state.systemPromptTokens = 17_000
    const config = makeConfig({ majorGcThresholdPercent: "100%" })

    const messages: WithParts[] = [makeTextMessage("u0", "start")]
    for (let i = 1; i <= 10; i++) {
        messages.push(makeToolMessage(`t${i}`, MEDIUM_OUTPUT))
    }
    messages.push(makeTextMessage("u1", "latest question"))
    // 229_379 + output 100 = 229_479 (the exact production token count).
    messages.push(makeAssistantWithTokens("a1", 229_379))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let truncatedCount = 0
    for (const m of messages) {
        const output = (m.parts[0] as any).state?.output
        if (typeof output === "string" && output.includes("[truncated for context space")) {
            truncatedCount++
        }
    }
    assert.ok(truncatedCount > 0, "must truncate at the overhead-aware threshold")
})

test("window too small for overhead: bails with ERROR instead of truncating", () => {
    const state = makeState(10_000)
    const config = makeConfig({ majorGcThresholdPercent: "100%" })
    const errors: string[] = []
    const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => {
            errors.push(msg)
        },
        saveContext: () => {},
        child: () => logger,
    } as unknown as Logger

    const messages: WithParts[] = [
        makeToolMessage("t1", LARGE_OUTPUT),
        makeTextMessage("u1", "latest question"),
        makeAssistantWithTokens("a1", 1_000),
    ]

    truncateLargeToolOutputs(state, config, logger, messages)

    const output = (messages[0]!.parts[0] as any).state.output
    assert.ok(
        !output.includes("[truncated for context space"),
        "must not truncate when the window cannot fit the overhead",
    )
    assert.ok(
        errors.some((e) => e.includes("too small to fit overhead")),
        `expected an overhead error, got: ${JSON.stringify(errors)}`,
    )
})

test("fallback limit drives truncation when model limit unknown (#346)", () => {
    // The production sessions never learned the model limit (spawn+resume,
    // empty catalog). With compress.contextLimitFallback the safety net must
    // still work against the fallback window.
    const state = makeState()
    state.modelContextLimit = undefined
    const config = makeConfig({ majorGcThresholdPercent: "100%" })
    config.compress.contextLimitFallback = 200_000

    const messages: WithParts[] = [makeTextMessage("u0", "start")]
    for (let i = 1; i <= 10; i++) {
        messages.push(makeToolMessage(`t${i}`, MEDIUM_OUTPUT))
    }
    messages.push(makeTextMessage("u1", "latest question"))
    // 200_000 + output 100 = 200_100 ≥ threshold min(200_000, 183_616)
    messages.push(makeAssistantWithTokens("a1", 200_000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let truncatedCount = 0
    for (const m of messages) {
        const output = (m.parts[0] as any).state?.output
        if (typeof output === "string" && output.includes("[truncated for context space")) {
            truncatedCount++
        }
    }
    assert.ok(truncatedCount > 0, "fallback limit must drive in-flight truncation")
})
