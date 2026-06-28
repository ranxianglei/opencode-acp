import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { TURN_NUDGE } from "../lib/prompts/turn-nudge"
import { CONTEXT_LIMIT_NUDGE } from "../lib/prompts/context-limit-nudge"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { buildContextUsageGuidance } from "../lib/messages/inject/utils"
import { createSessionState } from "../lib/state"

const MODEL_CONTEXT_LIMIT = 100_000
const LOW_USAGE = 20_000
const MODERATE_USAGE = 40_000
const HIGH_USAGE = 50_000

/**
 * PluginConfig fixture whose thresholds (30% / 45%) place the three usage points
 * LOW_USAGE / MODERATE_USAGE / HIGH_USAGE into distinct tiers so each tier's
 * wording can be asserted independently. Mirrors the shape used in
 * tests/inject.test.ts; only compress.minContextLimit / maxContextLimit are read.
 */
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
            maxContextLimit: "45%",
            minContextLimit: "30%",
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
            batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

test("TURN_NUDGE uses conditional compression language with decompress safety net", () => {
    assert.match(TURN_NUDGE, /finished reading/i)
    assert.match(TURN_NUDGE, /decompress later/i)
    assert.doesNotMatch(TURN_NUDGE, /\bnow\b/i)
})

test("CONTEXT_LIMIT_NUDGE frames compression as a step with decompress safety net", () => {
    assert.match(CONTEXT_LIMIT_NUDGE, /time to compress/i)
    assert.match(CONTEXT_LIMIT_NUDGE, /decompress/i)
    assert.doesNotMatch(CONTEXT_LIMIT_NUDGE, /\b(MUST|CRITICAL)\b/)
})

test("buildCompressedBlockGuidance lists every active block ID with topic when there are 20 or fewer", () => {
    const state = createSessionState()
    for (const id of [1, 2, 3]) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            blockId: id,
            runId: id,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 100,
            durationMs: 0,
            mode: "range",
            topic: `topic-${id}`,
            startId: "m0",
            endId: "m5",
            anchorMessageId: `a-${id}`,
            compressMessageId: `c-${id}`,
            compressCallId: undefined,
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 1000,
            deactivatedAt: undefined,
            deactivatedByBlockId: undefined,
            summary: "summary body",
            survivedCount: 0,
            generation: "young",
        })
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /b1: "topic-1", b2: "topic-2", b3: "topic-3"/)
    assert.doesNotMatch(guidance, /older, use decompress to access by ID/)
})

test("buildCompressedBlockGuidance summarizes older blocks with range + savings when there are more than 20 active", () => {
    const state = createSessionState()
    // 25 blocks (ids 1..25): the 20 most recent are 6..25, leaving 5 older.
    for (let id = 1; id <= 25; id++) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            blockId: id,
            runId: id,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 200,
            durationMs: 0,
            mode: "range",
            topic: `t-${id}`,
            startId: "m0",
            endId: "m5",
            anchorMessageId: `a-${id}`,
            compressMessageId: `c-${id}`,
            compressCallId: undefined,
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 1000,
            deactivatedAt: undefined,
            deactivatedByBlockId: undefined,
            summary: "summary body",
            survivedCount: 0,
            generation: "young",
        })
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /b6-b25 \+ 5 older\. Total: ~5K tokens compressed/)
    assert.match(guidance, /b25/)
})

test("buildCompressedBlockGuidance shows merge hint when more than 50 blocks active", () => {
    const state = createSessionState()
    for (let id = 1; id <= 60; id++) {
        state.prune.messages.activeBlockIds.add(id)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /merge_blocks tool/)
    assert.match(guidance, /You have 60 blocks/)
})

test("buildCompressedBlockGuidance omits merge hint when block count is at or below 50", () => {
    const state = createSessionState()
    for (let id = 1; id <= 50; id++) {
        state.prune.messages.activeBlockIds.add(id)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.doesNotMatch(guidance, /merge_blocks/)
})

test("buildContextUsageGuidance low tier says 'Be frugal' and leaks no threshold numbers", () => {
    const guidance = buildContextUsageGuidance(buildConfig(), LOW_USAGE, MODEL_CONTEXT_LIMIT)

    assert.match(guidance, /Be frugal/)
    assert.doesNotMatch(guidance, /threshold/i)
})

test("buildContextUsageGuidance moderate tier says 'Context is growing'", () => {
    const guidance = buildContextUsageGuidance(buildConfig(), MODERATE_USAGE, MODEL_CONTEXT_LIMIT)

    assert.match(guidance, /Context is growing/)
})

test("buildContextUsageGuidance high tier says 'Context is high'", () => {
    const guidance = buildContextUsageGuidance(buildConfig(), HIGH_USAGE, MODEL_CONTEXT_LIMIT)

    assert.match(guidance, /Context is high/)
})
