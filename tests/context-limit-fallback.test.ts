import assert from "node:assert/strict"
import test from "node:test"

import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import { resolveEffectiveContextLimit } from "../lib/state/utils"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { Logger } from "../lib/logger"

// Issue #346: in headless spawn+resume mode the model limit was never known
// (no persistence, empty catalog), so percentage thresholds resolved to
// undefined and every safety net (nudges, GC, in-flight truncation) was
// silently disabled. compress.contextLimitFallback restores the safety net
// against a configurable window when the model limit is unknown.

function makeState(modelContextLimit?: number): SessionState {
    return {
        sessionId: "session-fallback",
        isSubAgent: false,
        modelContextLimit,
        lastCompaction: 0,
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

function makeConfig(fallback: number | undefined): PluginConfig {
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
            summaryBuffer: false,
            maxContextLimit: "80%",
            minContextLimit: "80%",
            contextLimitFallback: fallback,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
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
        },
    } as unknown as PluginConfig
}

function makeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session-fallback",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeAssistantWithTokens(id: string, inputTokens: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-fallback",
            createdAt: new Date().toISOString(),
            tokens: { input: inputTokens, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        parts: [{ type: "text", text: "ok" }] as any,
    }
}

// ─── resolveEffectiveContextLimit ─────────────────────────────────────────────

test("resolveEffectiveContextLimit: known model limit wins over fallback", () => {
    const state = makeState(200_000)
    const config = makeConfig(128_000)

    assert.deepEqual(resolveEffectiveContextLimit(state, config), {
        limit: 200_000,
        source: "model",
    })
})

test("resolveEffectiveContextLimit: fallback used when model limit unknown", () => {
    const state = makeState(undefined)
    const config = makeConfig(128_000)

    assert.deepEqual(resolveEffectiveContextLimit(state, config), {
        limit: 128_000,
        source: "fallback",
    })
})

test("resolveEffectiveContextLimit: zero model limit falls through to fallback", () => {
    const state = makeState(0)
    const config = makeConfig(128_000)

    assert.deepEqual(resolveEffectiveContextLimit(state, config), {
        limit: 128_000,
        source: "fallback",
    })
})

test("resolveEffectiveContextLimit: fallback 0 disables the fallback (legacy behavior)", () => {
    const state = makeState(undefined)
    const config = makeConfig(0)

    assert.equal(resolveEffectiveContextLimit(state, config), undefined)
})

test("resolveEffectiveContextLimit: undefined fallback disables the fallback", () => {
    const state = makeState(undefined)
    const config = makeConfig(undefined)

    assert.equal(resolveEffectiveContextLimit(state, config), undefined)
})

// ─── isContextOverLimits with the fallback ────────────────────────────────────

test("isContextOverLimits: fallback drives thresholds when model limit unknown (#346)", () => {
    const state = makeState(undefined)
    const config = makeConfig(128_000)
    const messages = [makeUserMessage("u1", "hi"), makeAssistantWithTokens("a1", 110_000)]

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    // currentTokens = 110_000 + 100 output = 110_100; 80% of 128_000 = 102_400
    assert.equal(result.currentTokens, 110_100)
    assert.equal(result.overMinLimit, true)
    assert.equal(result.overMaxLimit, true)
    assert.equal(result.modelContextLimit, 128_000)
})

test("isContextOverLimits: below the fallback threshold no limit is crossed", () => {
    const state = makeState(undefined)
    const config = makeConfig(128_000)
    const messages = [makeUserMessage("u1", "hi"), makeAssistantWithTokens("a1", 50_000)]

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    // 50_100 < 102_400 (80% of 128_000)
    assert.equal(result.currentTokens, 50_100)
    assert.equal(result.overMinLimit, false)
    assert.equal(result.overMaxLimit, false)
    assert.equal(result.modelContextLimit, 128_000)
})

test("isContextOverLimits: fallback disabled (0) restores legacy no-threshold behavior", () => {
    const state = makeState(undefined)
    const config = makeConfig(0)
    const messages = [makeUserMessage("u1", "hi"), makeAssistantWithTokens("a1", 110_000)]

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(result.overMinLimit, false)
    assert.equal(result.overMaxLimit, false)
    assert.equal(result.modelContextLimit, undefined)
})

test("isContextOverLimits: known model limit takes precedence over fallback", () => {
    const state = makeState(200_000)
    const config = makeConfig(128_000)
    const messages = [makeUserMessage("u1", "hi"), makeAssistantWithTokens("a1", 170_000)]

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    // 80% of 200_000 = 160_000; 170_100 > 160_000 → over, against the MODEL window
    assert.equal(result.overMinLimit, true)
    assert.equal(result.overMaxLimit, true)
    assert.equal(result.modelContextLimit, 200_000)
})

// ─── §5.7 growth cycle with the fallback (multi-turn, side-effect asserts) ──

test("growth cycle: fallback drives the nudge across turns without a known limit (#346, §5.7)", () => {
    // Production shape: model limit unknown (spawn+resume), fallback 128K,
    // preserveRecentMessages 20 (production default). Thresholds: min 50% of
    // 128K = 64_000, max 80% = 102_400. Turn anchors are only added when
    // overMinLimit (and NOT overMaxLimit — that branch takes the
    // context-limit anchors) — pre-fix (no fallback) overMinLimit was never
    // true, so the turn-2 anchor assertion is the pre-fix discriminator.
    const state = makeState(undefined)
    const config = makeConfig(128_000)
    config.compress.preserveRecentMessages = 20
    config.compress.minContextLimit = "50%"
    config.compress.maxContextLimit = "80%"
    const logger = new Logger(false)

    // Turn 1: 50_100 < 64_000 → below the min limit; baseline established.
    const turn1: WithParts[] = [
        makeUserMessage("u1", "question one"),
        makeAssistantWithTokens("a1", 50_000),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 50_100, "baseline = turn-1 currentTokens")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "no growth yet → no nudge")
    assert.equal(state.nudges.turnNudgeAnchors.size, 0, "below min limit → no turn anchors")

    // Turn 2: 70_100 ≥ 64_000 (overMin) but ≤ 102_400 (not overMax) → the
    // turn-anchor branch. The turn ends on a user message (a2 answered, u2b
    // asks the next question), which is the shape that adds turn anchors.
    // Growth 20_000 < nudgeGrowthTokens 50_000 (and < growth floor 22_500)
    // → no nudge yet, but the anchors and baseline state are observable.
    const turn2: WithParts[] = [
        makeUserMessage("u2", "question two"),
        makeAssistantWithTokens("a2", 70_000),
        makeUserMessage("u2b", "question two follow-up"),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(
        state.nudges.turnNudgeAnchors.size,
        2,
        "overMinLimit (fallback) must add turn anchors (the last user msg + last assistant)",
    )
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "not overMax → no context-limit anchors")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "growth below threshold → no nudge yet")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 50_100, "baseline stable (only compress resets)")

    // Turn 3: 130_100 > 102_400 → overMax (context-limit anchor branch);
    // growth 80_000 from the 50_100 baseline ≥ 50_000 and ≥ growth floor
    // 22_500 → nudge fires.
    const turn3: WithParts[] = [
        makeUserMessage("u3", "question three"),
        makeAssistantWithTokens("a3", 130_000),
        makeUserMessage("u3b", "question three follow-up"),
    ]
    injectCompressNudges(state, config, logger, turn3, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "growth nudge fires past the fallback limits")
    assert.equal(state.nudges.contextLimitAnchors.size, 1, "overMax adds a context-limit anchor")
    assert.equal(state.nudges.lastNudgeShownTokens, 130_100, "lastNudgeShownTokens = currentTokens")
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        50_100,
        "baseline survives the growth cycle (PR-207 invariant)",
    )
})
