import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"

// Issue #476 — growth nudges must be suppressed when the analysis finds zero
// compressible ranges AND zero protected messages (the "vacuous hole": all
// three legacy flags false → nudge fired with nothing actionable → model
// guessed IDs → retry loop). §5.7: multi-turn, side-effect assertions,
// production config (preserveRecentMessages > 0).

const SID = "ses-nudge-no-ranges"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 900_000,
            minContextLimit: 20_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minNudgeContextPercent: 5,
            maxSummaryLengthHard: 10000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
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

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "a",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMsgWithTokens(
    id: string,
    text: string,
    tokens: { input: number; output: number },
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "a",
            time: { created: 2 },
            tokens,
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

const logger = new Logger(false)

test("issue #476: growth nudge suppressed when visible context is only compressed blocks (case a: zero ranges AND zero protected refs)", () => {
    const state = createSessionState()
    state.modelContextLimit = 100_000
    const config = buildConfig()
    config.compress.maxContextLimit = 90_000
    config.compress.minContextLimit = 4_000
    config.compress.minNudgeContextPercent = 2 // floor 2_000 of 100K
    config.compress.nudgeGrowthTokens = 6_000 // small threshold: keeps the fixture independent of BPE magnitude
    // production default (§5.7.1); moot here because there are no visible raw
    // messages left to zone
    config.compress.preserveRecentMessages = 20

    // Turn 1: honest small session establishes the baseline.
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 10_000, output: 2_000 }),
    ]
    // Real pipeline order: refs are assigned before nudge analysis
    // (buildCompressibleRanges skips ref-less messages).
    assignMessageRefs(state, turn1)
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: baseline only")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 12_000, "turn 1: baseline recorded")

    // Turn 2: everything compressible has been consumed into blocks; prune()
    // replaced it with the synthetic summary, so the visible window contains
    // NO raw messages. computeProtectedRefs sees zero visible raw messages →
    // protectedRefs ∅; buildCompressibleRanges finds nothing → compressible []
    // and protected []. All three legacy flags (allProtected, allInProtectedZone,
    // allBelowMin) are false — the exact hole the incident hit. The summary
    // text (~189K chars ≈ 38K+ BPE tokens via the getCurrentTokenUsage fallback)
    // keeps growth over the 6_000 threshold so nudgeAllowed is TRUE; only the
    // suppression gate can stop the phantom nudge.
    const sentence =
        "The quick brown fox jumps over the lazy dog near the riverbank while the wind blows softly through the old oak trees. "
    const syntheticSummary: WithParts = {
        info: {
            id: "msg_dcp_summary_b0",
            role: "assistant",
            sessionID: SID,
            agent: "a",
            time: { created: 3 },
        } as WithParts["info"],
        parts: [textPart("msg_dcp_summary_b0", sentence.repeat(1600))],
    }
    const turn2: WithParts[] = [syntheticSummary]
    const before = JSON.stringify(turn2)
    injectCompressNudges(state, config, logger, turn2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "nudgeAllowed with zero ranges + zero protected refs ⇒ suppressed, not injected",
    )
    assert.equal(
        JSON.stringify(turn2),
        before,
        "suppression must not mutate any message (no nudge text appended)",
    )
    // Side-effect assertions (§5.7.1): suppression must leave baselines intact
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        12_000,
        "baseline must not move on a suppressed turn",
    )
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge was shown")

    // Turn 3: same conditions repeat → still suppressed (stable, no drift)
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 3: still suppressed")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 12_000, "turn 3: baseline intact")
})

test("issue #476: inflated relay report (1.76x) must not reach the growth heuristic end-to-end", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.systemPromptTokens = 1_000
    const config = buildConfig()
    config.compress.preserveRecentMessages = 20 // production default (§5.7.1)

    // Turn 1: payload est = (8_000+16_000)/4 = 6_000 + 1_000 system = 7_000
    const mkTurn = (aid: string, input: number): WithParts[] => [
        userMsg("u1", "u".repeat(8_000)),
        assistantMsgWithTokens(aid, "a".repeat(16_000), { input, output: 2_000 }),
    ]
    assignMessageRefs(state, mkTurn("a1", 98_000))
    injectCompressNudges(state, config, logger, mkTurn("a1", 98_000), {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: baseline only")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)

    // Turn 2: relay inflates the report to 176_000 (1.76x) while the payload is
    // unchanged. Pre-fix this read as +76K honest growth → nudgeAllowed with
    // zero ranges → phantom nudge. Post-fix the sanitized figure is the 7_000
    // estimate: below minContextLimit (20K) → no decision, and the baseline
    // correction path resets to the shrunken (honest) size.
    assignMessageRefs(state, mkTurn("a2", 174_000))
    injectCompressNudges(state, config, logger, mkTurn("a2", 174_000), {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "inflated report must not trigger a growth nudge",
    )
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge was shown")
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        7_000,
        "sanitized estimate flowed through: baseline corrected to honest size",
    )
})

test("control: nudge STILL fires when older unprotected content exits the recent zone", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.preserveRecentMessages = 2 // only last 2 messages protected

    // Turn 1: u1/a1 are large-text but inside the recent zone of 2.
    const turn1: WithParts[] = [
        userMsg("u1", "U".repeat(20_000)), // ≈5K est tokens
        assistantMsgWithTokens("a1", "A".repeat(20_000), { input: 100_000, output: 10_000 }),
    ]
    assignMessageRefs(state, turn1)
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: baseline only")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 110_000)

    // Turn 2: u2/a2 arrive → u1/a1 exit the recent zone and form a compressible
    // range (~10K est ≥ minCompressRange 5_000). Same usage growth as the
    // suppression test → the ONLY difference is the range's existence.
    const turn2: WithParts[] = [
        ...turn1,
        userMsg("u2", "more"),
        assistantMsgWithTokens("a2", "result", { input: 150_000, output: 10_000 }),
    ]
    assignMessageRefs(state, turn2)
    injectCompressNudges(state, config, logger, turn2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "fix must not over-suppress: actionable range present ⇒ nudge fires",
    )
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        160_000,
        "shown-token marker updated when the nudge actually injects",
    )
})
