import assert from "node:assert/strict"
import test from "node:test"

import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import { resolveEffectiveContextLimit } from "../lib/state/utils"
import { isContextOverLimits } from "../lib/messages/inject/utils"

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
