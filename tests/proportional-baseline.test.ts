import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"

const SID = "ses-proportional-test"

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
            maxContextLimit: 800_000,
            minContextLimit: 200_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minNudgeContextPercent: 15,
            maxSummaryLengthHard: 10000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
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
            batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

const logger = new Logger(false)

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function compressToolPart(callID: string, output: string) {
    return {
        id: `${callID}-part`, messageID: "msg", sessionID: SID,
        type: "tool" as const, tool: "compress", callID,
        state: { status: "completed" as const, input: {}, output },
    }
}

function assistantCompressMsg(
    id: string,
    text: string,
    tokens: { input: number; output: number },
): WithParts {
    return {
        info: {
            id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 },
            tokens,
        } as WithParts["info"],
        parts: [compressToolPart(`${id}-c`, "compressed"), textPart(id, text)],
    }
}

function assistantMsg(
    id: string,
    text: string,
    tokens: { input: number; output: number },
): WithParts {
    return {
        info: {
            id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 },
            tokens,
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function runCompressWithPreTokens(
    state: ReturnType<typeof createSessionState>,
    config: PluginConfig,
    messages: WithParts[],
    preCompressTokens: number,
): void {
    injectCompressNudges(state, config, logger, messages, {} as any, undefined, undefined, preCompressTokens)
}

function setupNudgeTriggeredState(baseline: number): ReturnType<typeof createSessionState> {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = baseline
    state.nudges.lastNudgeShownTokens = baseline
    return state
}

// ─── Full compress: ratio ≥ 0.5 → adjustment = 1.0 (full push) ──────────────

test("proportional baseline: full compress (80% of growth) → full push to postCompress", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 210_000)
})

test("proportional baseline: exactly 50% boundary → adjustment = 1.0 (full push)", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 25_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 225_000)
})

test("proportional baseline: 60% of growth → full push (ratio*2 > 1, capped)", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 20_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 220_000)
})

// ─── Partial compress: ratio < 0.5 → partial push ────────────────────────────

test("proportional baseline: 25% of growth → half push", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 60_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 280_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 230_000)
})

test("proportional baseline: 37.5% of growth → 75% push", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 50_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 280_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 237_500)
})

// ─── Tiny compress: ratio very low → minimal push ────────────────────────────

test("proportional baseline: 10% of growth → 20% push", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 90_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 300_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 218_000)
})

test("proportional baseline: 1% of growth → 2% push (barely moves)", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 99_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 300_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 201_980)
})

// ─── Over-compress: ratio > 1.0 → baseline drops below original ──────────────

test("proportional baseline: over-compress (140% of growth) → baseline drops below original", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 160_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 170_000)
})

test("proportional baseline: over-compress exactly 200% → capped at ratio=1, full push down", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 160_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 300_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 170_000)
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

test("proportional baseline: growth=0 (preCompress == baseline) → falls to else, baseline = postCompress", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 160_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 200_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 170_000)
})

test("proportional baseline: growth < 0 (preCompress < baseline) → falls to else, baseline = postCompress", () => {
    const state = setupNudgeTriggeredState(250_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 230_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 210_000)
})

test("proportional baseline: preCompressTokens undefined → falls to else, baseline = postCompress (current behavior without preCompress)", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 25_000 }),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 225_000)
})

test("proportional baseline: voluntary compress (no nudge shown) → proportional path skipped entirely", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 25_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "voluntary compress keeps original baseline — no proportional adjustment",
    )
    assert.equal(state.nudges.compressBaselineSet, false, "lock NOT set for voluntary compress")
})

test("proportional baseline: compressBaselineSet lock prevents double-adjustment in continuation", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 25_000 }),
    ]
    runCompressWithPreTokens(state, config, messages, 250_000)
    const baselineAfterFirst = state.nudges.lastPerMessageNudgeTokens
    assert.equal(state.nudges.compressBaselineSet, true)

    const messages2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 25_000 }),
        assistantMsg("a2", "continuing", { input: 220_000, output: 5_000 }),
    ]
    runCompressWithPreTokens(state, config, messages2, 250_000)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        baselineAfterFirst,
        "second call in same turn must NOT re-adjust — compressBaselineSet lock prevents it",
    )
})

// ─── Multi-cycle: compress → grow → compress → verify baseline advances ─────

test("multi-cycle: two proportional compresses advance baseline correctly", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()

    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "done", { input: 200_000, output: 60_000 }),
    ]
    runCompressWithPreTokens(state, config, turn1, 280_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 230_000)

    const turn2: WithParts[] = [
        userMsg("u2", "next turn — releases lock"),
        assistantMsg("a2", "response", { input: 250_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.compressBaselineSet, false, "lock released on new turn without compress")

    state.nudges.lastNudgeShownTokens = state.nudges.lastPerMessageNudgeTokens
    const turn3: WithParts[] = [
        userMsg("u3", "compress again"),
        assistantCompressMsg("a3", "done", { input: 250_000, output: 30_000 }),
    ]
    runCompressWithPreTokens(state, config, turn3, 310_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 267_500)
})

test("multi-cycle: small compress then large compress → baseline tracks growth correctly", () => {
    const state = setupNudgeTriggeredState(100_000)
    const config = buildConfig()

    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "tiny compress", { input: 100_000, output: 95_000 }),
    ]
    runCompressWithPreTokens(state, config, turn1, 200_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 109_500)

    const turn2: WithParts[] = [
        userMsg("u2", "new turn"),
        assistantMsg("a2", "response", { input: 180_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)

    state.nudges.lastNudgeShownTokens = state.nudges.lastPerMessageNudgeTokens
    const turn3: WithParts[] = [
        userMsg("u3", "big compress now"),
        assistantCompressMsg("a3", "done", { input: 120_000, output: 10_000 }),
    ]
    runCompressWithPreTokens(state, config, turn3, 250_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 130_000)
})

// ─── Effect on next nudge timing ─────────────────────────────────────────────

test("after proportional baseline: next nudge fires at correct threshold (not too early, not too late)", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()

    const compressTurn: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "25% compress", { input: 200_000, output: 60_000 }),
    ]
    runCompressWithPreTokens(state, config, compressTurn, 280_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 230_000)

    const growTurn: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsg("a2", "response", { input: 250_000, output: 20_000 }),
    ]
    injectCompressNudges(state, config, logger, growTurn, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "40K growth from 230K baseline (270K) < 50K threshold → no nudge yet",
    )

    const growTurn2: WithParts[] = [
        userMsg("u3", "more"),
        assistantMsg("a3", "response", { input: 260_000, output: 25_000 }),
    ]
    injectCompressNudges(state, config, logger, growTurn2, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "55K growth from 230K baseline (285K) >= 50K threshold → nudge fires",
    )
})

test("proportional vs full-reset: partial compress delays next nudge less than full-reset would", () => {
    const state = setupNudgeTriggeredState(200_000)
    const config = buildConfig()

    const compressTurn: WithParts[] = [
        userMsg("u1", "hello"),
        assistantCompressMsg("a1", "10% compress", { input: 200_000, output: 90_000 }),
    ]
    runCompressWithPreTokens(state, config, compressTurn, 300_000)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 218_000)

    const growTurn: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsg("a2", "response", { input: 250_000, output: 19_000 }),
    ]
    injectCompressNudges(state, config, logger, growTurn, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "51K growth from 218K baseline (269K) >= 50K threshold → nudge fires (proportional kept baseline low)",
    )
})
