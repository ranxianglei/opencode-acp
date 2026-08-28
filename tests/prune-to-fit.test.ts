import assert from "node:assert/strict"
import test from "node:test"

import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"
import { countTokens } from "../lib/token-utils"
import { pruneToFit, resolveKnownWindow } from "../lib/messages/prune-to-fit"
import {
    trackUncalibratedWindow,
    UNCALIBRATED_WINDOW_WARN_THRESHOLD,
} from "../lib/messages/uncalibrated-window"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Marker written by the guard into a cleared tool output (mirrors the source
 *  constant in lib/messages/prune-to-fit.ts). */
const CLEAR_PLACEHOLDER = "[cleared by ACP overflow guard — re-run tool if needed]"

interface LogCall {
    level: "debug" | "info" | "warn" | "error"
    message: string
    data?: unknown
}

function makeCapturingLogger(): { logger: Logger; calls: LogCall[] } {
    const calls: LogCall[] = []
    const push = (level: LogCall["level"]) => (message: string, data?: unknown) =>
        calls.push({ level, message, data })
    const logger = {
        debug: push("debug"),
        info: push("info"),
        warn: push("warn"),
        error: push("error"),
        child: () => logger,
    } as unknown as Logger
    return { logger, calls }
}

const noopLogger: Logger = makeCapturingLogger().logger

/** Token-dense output (~28k tokens) so clearing one frees a predictable, large
 *  amount. Repeated single chars compress far too aggressively to be useful. */
const WORDS =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega "
const DENSE = WORDS.repeat(1000)

function makeConfig(
    overrides: {
        compress?: Partial<PluginConfig["compress"]>
        protectedFilePatterns?: string[]
    } = {},
): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: overrides.protectedFilePatterns ?? [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 15,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5000,
            preserveLastUserMessage: true,
            overflowGuard: true,
            overflowGuardReserve: 32768,
            ...overrides.compress,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
        },
    } as unknown as PluginConfig
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: "session-1",
        isSubAgent: false,
        modelContextLimit: 200000,
        modelProviderID: undefined,
        modelID: undefined,
        systemPromptTokens: undefined,
        lastCompaction: 0,
        currentTurn: 0,
        prune: {
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
            compressBaselineSet: false,
            lastProcessedCompressMessageId: undefined,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        compressionTiming: { startsByCallId: new Map(), pendingByCallId: new Map() },
        toolParameters: new Map(),
        toolIdList: [],
        qualityGateRetryPending: false,
        uncalibratedWindowTransforms: 0,
        uncalibratedWindowWarned: false,
        ...overrides,
    } as unknown as SessionState
}

function makeToolMessage(
    id: string,
    output: string,
    tool = "bash",
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
                tool,
                callID: `call-${id}`,
                state: { status, output, input: {}, time: {} },
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

/** Production shape: an assistant message whose LAST part is a completed tool
 *  result appended after the LLM call (so it is absent from `tokens.input`). */
function makeAssistantWithTrailingTool(
    id: string,
    inputTokens: number,
    toolOutput: string,
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
            tokens: { input: inputTokens, output: 100 },
        } as any,
        parts: [
            { type: "text", text: "ok" },
            {
                type: "tool",
                tool: "bash",
                callID: `call-${id}`,
                state: { status: "completed", output: toolOutput, input: {}, time: {} },
            },
        ] as any,
    }
}

function getOutput(msg: WithParts): string {
    return (msg.parts[0] as any).state.output as string
}

function isCleared(msg: WithParts): boolean {
    return getOutput(msg) === CLEAR_PLACEHOLDER
}

// ---------------------------------------------------------------------------
// resolveKnownWindow
// ---------------------------------------------------------------------------

test("resolveKnownWindow: returns modelContextLimit when the model reports a window", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 262144 })
    assert.equal(resolveKnownWindow(config, state, "prov", "model"), 262144)
})

test("resolveKnownWindow: falls back to per-model absolute maxContextLimit", () => {
    const config = makeConfig({
        compress: {
            maxContextLimit: "80%",
            modelMaxLimits: { "prov/model": 200000 },
        },
    })
    const state = makeState({
        modelContextLimit: undefined,
        modelProviderID: "prov",
        modelID: "model",
    })
    assert.equal(resolveKnownWindow(config, state, "prov", "model"), 200000)
})

test("resolveKnownWindow: falls back to global absolute maxContextLimit (number)", () => {
    const config = makeConfig({ compress: { maxContextLimit: 150000 } })
    const state = makeState({ modelContextLimit: undefined })
    assert.equal(resolveKnownWindow(config, state, "prov", "model"), 150000)
})

test("resolveKnownWindow: per-model limit takes precedence over global", () => {
    const config = makeConfig({
        compress: {
            maxContextLimit: 150000,
            modelMaxLimits: { "prov/model": 250000 },
        },
    })
    const state = makeState({
        modelContextLimit: undefined,
        modelProviderID: "prov",
        modelID: "model",
    })
    assert.equal(resolveKnownWindow(config, state, "prov", "model"), 250000)
})

test("resolveKnownWindow: returns undefined for a percent maxContextLimit with no window", () => {
    const config = makeConfig({ compress: { maxContextLimit: "80%" } })
    const state = makeState({ modelContextLimit: undefined })
    assert.equal(resolveKnownWindow(config, state, "prov", "model"), undefined)
})

test("resolveKnownWindow: returns undefined when nothing is configured", () => {
    const config = makeConfig({ compress: { maxContextLimit: "80%" } })
    const state = makeState({ modelContextLimit: undefined })
    // percent can't resolve without a window, no per-model entry
    assert.equal(resolveKnownWindow(config, state, undefined, undefined), undefined)
})

// ---------------------------------------------------------------------------
// pruneToFit — firing / not firing
// ---------------------------------------------------------------------------

test("pruneToFit: no-op when the estimate is under the safe budget", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        // estimate = 100000 + 100 + 8192 = 108292; safeBudget = 200000 - 32768 = 167232
        makeAssistantWithTokens("msg-asst", 100000),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), false, "should not clear when under budget")
    assert.equal(getOutput(messages[0]!), DENSE)
})

test("pruneToFit: clears the oldest tool output when over budget, stops when it fits", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) messages.push(makeToolMessage(`msg-${i}`, DENSE))
    messages.push(makeTextMessage("msg-user", "hello"))
    // estimate = 170000 + 100 + 8192 = 178292 > safeBudget 167232 → fire.
    // One DENSE output frees ~28k tokens, far more than the ~11k gap → stop after one.
    messages.push(makeAssistantWithTokens("msg-asst", 170000))

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), true, "oldest tool output should be cleared")
    for (let i = 1; i < 5; i++) {
        assert.equal(isCleared(messages[i]!), false, `msg-${i} should be untouched (guard stopped)`)
    }
})

test("pruneToFit: clears multiple oldest outputs for a large gap, never the last", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = []
    for (let i = 0; i < 6; i++) messages.push(makeToolMessage(`msg-${i}`, DENSE))
    messages.push(makeTextMessage("msg-user", "hello"))
    // estimate = 218940 + 100 + 8192 = 227232; gap = 60000 → needs ~3 outputs.
    messages.push(makeAssistantWithTokens("msg-asst", 218940))

    pruneToFit(state, config, noopLogger, messages)

    const clearedCount = messages.slice(0, 6).filter(isCleared).length
    assert.ok(clearedCount >= 2, `expected at least 2 cleared, got ${clearedCount}`)
    assert.equal(isCleared(messages[0]!), true, "oldest should be cleared")
    assert.equal(
        isCleared(messages[5]!),
        false,
        "newest tool output should be protected (guard stopped)",
    )
})

test("pruneToFit: skips protected tools even when over budget", () => {
    const config = makeConfig({ compress: { protectedTools: ["bash"] } })
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) messages.push(makeToolMessage(`msg-${i}`, DENSE, "bash"))
    messages.push(makeTextMessage("msg-user", "hello"))
    messages.push(makeAssistantWithTokens("msg-asst", 218940))

    pruneToFit(state, config, noopLogger, messages)

    for (let i = 0; i < 5; i++) {
        assert.equal(isCleared(messages[i]!), false, `protected tool msg-${i} must not be cleared`)
    }
})

test("pruneToFit: skips protected file paths even when over budget", () => {
    const config = makeConfig({ protectedFilePatterns: ["**/secret.txt"] })
    const state = makeState({ modelContextLimit: 200000 })
    // A read tool whose file path matches the protected pattern.
    const messages: WithParts[] = [
        {
            info: { id: "msg-0", role: "tool", sessionID: "s", createdAt: "" } as any,
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "c0",
                    state: {
                        status: "completed",
                        output: DENSE,
                        input: { filePath: "/a/secret.txt" },
                        time: {},
                    },
                },
            ] as any,
        },
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 218940),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), false, "protected-file tool output must not be cleared")
})

test("pruneToFit: is idempotent — already-cleared outputs are not double-counted", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    const msgs: WithParts[] = [
        makeToolMessage("msg-0", CLEAR_PLACEHOLDER), // already cleared by a prior pass
        makeToolMessage("msg-1", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 170000),
    ]

    pruneToFit(state, config, noopLogger, msgs)

    assert.equal(getOutput(msgs[0]!), CLEAR_PLACEHOLDER, "already-cleared output stays as-is")
    assert.equal(isCleared(msgs[1]!), true, "the next live output is cleared to make room")
})

test("pruneToFit: no-op when overflowGuard is disabled", () => {
    const config = makeConfig({ compress: { overflowGuard: false } })
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 218940),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), false, "disabled guard must not clear")
})

test("pruneToFit: no-op when no known window (percent maxContextLimit + no model limit)", () => {
    const config = makeConfig({ compress: { maxContextLimit: "80%" } })
    const state = makeState({ modelContextLimit: undefined })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 218940),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), false, "guard cannot fire without a known window")
})

test("pruneToFit: fires using an absolute maxContextLimit when the model reports no window", () => {
    const config = makeConfig({ compress: { maxContextLimit: 150000 } })
    const state = makeState({ modelContextLimit: undefined })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        // safeBudget = 150000 - 32768 = 117232; estimate = 140000 + 8292 = 148292 > 117232
        makeAssistantWithTokens("msg-asst", 140000),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), true, "guard should fire via absolute maxContextLimit")
})

test("pruneToFit: no-op when safeBudget is non-positive (reserve >= window)", () => {
    const config = makeConfig({ compress: { overflowGuardReserve: 32768 } })
    const state = makeState({ modelContextLimit: 10000 })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 218940),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(isCleared(messages[0]!), false, "guard must not run with a non-positive budget")
})

test("pruneToFit: respects the recent-message protection zone (byRawId + preserveRecentMessages)", () => {
    const config = makeConfig({ compress: { preserveRecentMessages: 2, preserveRecentTokens: 0 } })
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = []
    for (let i = 0; i < 6; i++) messages.push(makeToolMessage(`msg-${i}`, DENSE))
    // estimate = 327000 + 100 + 8192 = 335292; gap = 168060 → needs ~6 clears,
    // forcing the guard all the way to the protected zone.
    messages.push(makeAssistantWithTokens("msg-asst", 327000))

    // Give refs so computeProtectedRefs protects the last 2 visible messages
    // (msg-5 + msg-asst). msg-4 sits just outside the zone.
    const byRawId = new Map<string, string>()
    messages.forEach((m, i) => byRawId.set(m.info.id, `m${String(i + 1).padStart(5, "0")}`))
    state.messageIds.byRawId = byRawId

    pruneToFit(state, config, logger, messages)

    // Gap requires ~6 clears; the guard clears msg-0..4 (5) then reaches msg-5,
    // which is in the protected zone and is skipped (not because the guard
    // stopped — the budget is still exceeded).
    for (let i = 0; i < 5; i++) {
        assert.equal(isCleared(messages[i]!), true, `msg-${i} should be cleared`)
    }
    assert.equal(
        isCleared(messages[5]!),
        false,
        "msg-5 is in the recent zone and must be protected",
    )
    // Nothing more is clearable (msg-5 protected, msg-asst is the current turn) → ERROR.
    const errors = calls.filter((c) => c.level === "error" && c.message.includes("overflow guard"))
    assert.equal(errors.length, 1, "should log an ERROR when the zone blocks the last needed clear")
})

test("pruneToFit: no crash on empty messages / no tool outputs", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    pruneToFit(state, config, noopLogger, [])
    pruneToFit(state, config, noopLogger, [
        makeTextMessage("m1", "text"),
        makeAssistantWithTokens("m2", 218940),
    ])
})

test("pruneToFit: logs a WARN when it clears outputs to fit", () => {
    const { logger, calls } = makeCapturingLogger()
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 170000),
    ]

    pruneToFit(state, config, logger, messages)

    const warns = calls.filter((c) => c.level === "warn" && c.message.includes("overflow guard"))
    assert.equal(warns.length, 1, "should log exactly one overflow-guard WARN")
})

test("pruneToFit: logs an ERROR when it clears everything but still exceeds the window", () => {
    const { logger, calls } = makeCapturingLogger()
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    // Only ONE clearable output, but the gap is far larger than it can free → ERROR.
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 500000),
    ]

    pruneToFit(state, config, logger, messages)

    const errors = calls.filter((c) => c.level === "error" && c.message.includes("overflow guard"))
    assert.equal(errors.length, 1, "should log an overflow-guard ERROR when it cannot fit")
})

test("pruneToFit: counts trailing tool outputs appended after the last LLM call (B1)", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    // safeBudget = 200000 - 32768 = 167232. The last assistant's provider tokens
    // (140000) do NOT include its trailing tool output (DENSE ~28001). Without the
    // B1 fix, estimate = 140000 + 100 + 8192 = 148292 < 167232 → no fire. With the
    // fix, estimate = 148292 + 28001 = 176293 > 167232 → fire.
    const messages: WithParts[] = [
        makeToolMessage("msg-old", DENSE),
        makeAssistantWithTrailingTool("msg-asst", 140000, DENSE),
    ]

    pruneToFit(state, config, noopLogger, messages)

    // The guard fires and clears the OLDER output, not the last assistant's
    // trailing output (current turn — protected via lastMsgId).
    assert.equal(isCleared(messages[0]!), true, "older tool output should be cleared")
    const trailing = (messages[1]!.parts[1] as any).state.output
    assert.equal(trailing, DENSE, "last assistant's trailing tool output must NOT be cleared")
})

test("pruneToFit: does not clear the current turn's trailing tool output even when it is the only overflow", () => {
    const config = makeConfig()
    const state = makeState({ modelContextLimit: 200000 })
    // Only the last assistant carries a big trailing tool output; there is no
    // older clearable output. The guard may fire (estimate over budget) but must
    // not clear the current turn — it logs an ERROR instead.
    const { logger, calls } = makeCapturingLogger()
    const messages: WithParts[] = [makeAssistantWithTrailingTool("msg-asst", 200000, DENSE)]

    pruneToFit(state, config, logger, messages)

    const trailing = (messages[0]!.parts[1] as any).state.output
    assert.equal(trailing, DENSE, "current turn's trailing tool output must NOT be cleared")
    const errors = calls.filter((c) => c.level === "error" && c.message.includes("overflow guard"))
    assert.equal(errors.length, 1, "should log an ERROR (over window, nothing clearable)")
})

test("pruneToFit: respects an explicit overflowGuardReserve of 0 (nullish, not falsy)", () => {
    const config = makeConfig({ compress: { overflowGuardReserve: 0 } })
    const state = makeState({ modelContextLimit: 200000 })
    // safeBudget = 200000 - 0 = 200000 (reserve 0 respected, not defaulted to 32768).
    // estimate = 195000 + 100 + 8192 = 203292 > 200000 → fire.
    const messages: WithParts[] = [
        makeToolMessage("msg-0", DENSE),
        makeTextMessage("msg-user", "hello"),
        makeAssistantWithTokens("msg-asst", 195000),
    ]

    pruneToFit(state, config, noopLogger, messages)

    assert.equal(
        isCleared(messages[0]!),
        true,
        "reserve 0 must be respected (budget = full window)",
    )
})

// ---------------------------------------------------------------------------
// trackUncalibratedWindow (Fix 1: WARN on uncalibrated window)
// ---------------------------------------------------------------------------

test("trackUncalibratedWindow: warns once after the threshold of uncalibrated transforms", () => {
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: undefined })

    // Below threshold: no warn.
    for (let i = 0; i < UNCALIBRATED_WINDOW_WARN_THRESHOLD - 1; i++) {
        trackUncalibratedWindow(state, logger)
    }
    assert.equal(calls.filter((c) => c.level === "warn").length, 0, "no warn below threshold")
    assert.equal(state.uncalibratedWindowTransforms, UNCALIBRATED_WINDOW_WARN_THRESHOLD - 1)

    // At threshold: warn fires.
    trackUncalibratedWindow(state, logger)
    assert.equal(calls.filter((c) => c.level === "warn").length, 1, "warn fires at threshold")
    assert.equal(state.uncalibratedWindowWarned, true)
})

test("trackUncalibratedWindow: never warns when a window is resolved", () => {
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: 262144 })

    for (let i = 0; i < UNCALIBRATED_WINDOW_WARN_THRESHOLD + 2; i++) {
        trackUncalibratedWindow(state, logger)
    }
    assert.equal(
        calls.filter((c) => c.level === "warn").length,
        0,
        "no warn with a resolved window",
    )
    assert.equal(state.uncalibratedWindowTransforms, 0, "counter stays 0 when calibrated")
})

test("trackUncalibratedWindow: warns only once (dedup across many transforms)", () => {
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: undefined })

    for (let i = 0; i < UNCALIBRATED_WINDOW_WARN_THRESHOLD + 10; i++) {
        trackUncalibratedWindow(state, logger)
    }
    assert.equal(calls.filter((c) => c.level === "warn").length, 1, "warn fires exactly once")
})

test("trackUncalibratedWindow: resets the counter when a window later resolves, then re-warns", () => {
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: undefined })

    // Climb to the warn threshold and fire.
    for (let i = 0; i < UNCALIBRATED_WINDOW_WARN_THRESHOLD; i++)
        trackUncalibratedWindow(state, logger)
    assert.equal(calls.filter((c) => c.level === "warn").length, 1)

    // A window resolves → counter resets.
    state.modelContextLimit = 262144
    trackUncalibratedWindow(state, logger)
    assert.equal(state.uncalibratedWindowTransforms, 0, "counter resets on calibration")

    // Window lost again → counter climbs from 0; warned flag still suppresses re-warn.
    state.modelContextLimit = undefined
    for (let i = 0; i < UNCALIBRATED_WINDOW_WARN_THRESHOLD; i++)
        trackUncalibratedWindow(state, logger)
    assert.equal(
        calls.filter((c) => c.level === "warn").length,
        1,
        "warned flag suppresses a second warn within the same session",
    )
})

test("trackUncalibratedWindow: counter accumulates across multiple turns (multi-turn)", () => {
    const { logger, calls } = makeCapturingLogger()
    const state = makeState({ modelContextLimit: undefined })

    // Simulate three consecutive turns, one transform each, all uncalibrated.
    trackUncalibratedWindow(state, logger) // turn 1
    trackUncalibratedWindow(state, logger) // turn 2
    assert.equal(state.uncalibratedWindowTransforms, 2, "counter persists across turns")
    trackUncalibratedWindow(state, logger) // turn 3 → threshold
    assert.equal(state.uncalibratedWindowTransforms, 3)
    assert.equal(calls.filter((c) => c.level === "warn").length, 1, "warns on the third turn")
})
