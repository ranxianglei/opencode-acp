import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { computeProtectedRefs, excludeProtectedRanges, type CompressibleRange } from "../lib/messages/inject/utils"
import { injectCompressNudges } from "../lib/messages/inject/inject"

const SID = "ses-preserve-test"

function buildCompress(p: Partial<PluginConfig["compress"]> = {}): PluginConfig["compress"] {
    return {
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
        minNudgeContextPercent: 15,
        maxSummaryLengthHard: 10000,
        minCompressRange: 5000,
        minNudgeGrowthRatio: 0.45,
        minNudgeGrowthFloor: 5000,
        emergencyThresholdPercent: "98%",
        maxVisibleSegments: 50,
        keepEmbedMaxChars: 2000,
        preserveRecentMessages: 20,
        preserveRecentTokens: 20000,
        preserveLastUserMessage: true,
        ...p,
    }
}

function buildConfig(compressOverrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
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
        compress: buildCompress(compressOverrides),
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

function msg(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "assistant",
            ...(role === "user" ? { model: { providerID: "anthropic", modelID: "claude-test" } } : {}),
            time: { created: 1 },
        } as WithParts["info"],
        parts: [{ id: `p-${id}`, messageID: id, sessionID: SID, type: "text" as const, text }],
    }
}

function buildMessages(count: number, charPerMsg: number): WithParts[] {
    const messages: WithParts[] = []
    for (let i = 1; i <= count; i++) {
        const id = `msg-${i}`
        const role: "user" | "assistant" = i % 2 === 1 ? "user" : "assistant"
        messages.push(msg(id, role, "x".repeat(charPerMsg)))
    }
    return messages
}

function setupRefs(state: ReturnType<typeof createSessionState>, count: number) {
    for (let i = 1; i <= count; i++) {
        state.messageIds.byRawId.set(`msg-${i}`, `m${String(i).padStart(5, "0")}`)
    }
}

const logger = new Logger(false)

function suffixText(messages: WithParts[]): string | null {
    const last = messages[messages.length - 1]
    if (!last) return null
    const parts = (last as any).parts as Array<{ type: string; text?: string }> | undefined
    if (!parts) return null
    const texts = parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!)
    return texts.length > 0 ? texts.join("") : null
}

// 50 msgs × 2000 chars = 500 tokens each
// preserveRecentMessages=20 → last 20 protected (m00031–m00050)
// preserveRecentTokens=20000 → 20000/500 = 40 msgs → last 40 protected (m00011–m00050)
// Combined: m00011–m00050 (token rule is broader)
test("computeProtectedRefs: default config protects last 40 msgs (token rule broader than count)", () => {
    const state = createSessionState()
    setupRefs(state, 50)
    const messages = buildMessages(50, 2000)
    const protectedRefs = computeProtectedRefs(messages, state, buildCompress())
    assert.ok(protectedRefs.has("m00050"), "last message protected")
    assert.ok(protectedRefs.has("m00011"), "msg-11 protected (token rule reaches here)")
    assert.ok(!protectedRefs.has("m00010"), "msg-10 NOT protected (outside token window)")
})

test("computeProtectedRefs: last user message always protected even with count=1", () => {
    const state = createSessionState()
    setupRefs(state, 50)
    const messages = buildMessages(50, 2000)
    const compress = buildCompress({ preserveRecentMessages: 1, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.ok(protectedRefs.has("m00050"), "last message protected by count")
    assert.ok(protectedRefs.has("m00049"), "last user message (msg-49) protected by user-msg rule")
    assert.ok(!protectedRefs.has("m00048"), "msg-48 NOT protected")
})

test("computeProtectedRefs: token-only protection (count=0)", () => {
    const state = createSessionState()
    setupRefs(state, 50)
    const messages = buildMessages(50, 2000)
    const compress = buildCompress({ preserveRecentMessages: 0, preserveRecentTokens: 10000 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.ok(protectedRefs.has("m00050"), "last message protected by tokens")
    assert.ok(protectedRefs.has("m00031"), "msg-31 protected (10K tokens / 500 = 20 msgs back)")
    assert.ok(!protectedRefs.has("m00030"), "msg-30 NOT protected (outside 10K window)")
})

test("computeProtectedRefs: all disabled returns empty set", () => {
    const state = createSessionState()
    setupRefs(state, 10)
    const messages = buildMessages(10, 2000)
    const compress = buildCompress({ preserveRecentMessages: 0, preserveRecentTokens: 0, preserveLastUserMessage: false })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.equal(protectedRefs.size, 0)
})

test("excludeProtectedRanges: removes ranges starting in protected zone, keeps others", () => {
    const ranges: CompressibleRange[] = [
        { startRef: "m00001", endRef: "m00010", count: 10, tokens: 5000, toolPct: 50, textPct: 50 },
        { startRef: "m00035", endRef: "m00045", count: 11, tokens: 5500, toolPct: 50, textPct: 50 },
        { startRef: "m00046", endRef: "m00050", count: 5, tokens: 2500, toolPct: 50, textPct: 50 },
    ]
    const protectedRefs = new Set(["m00031", "m00032", "m00033", "m00034", "m00035", "m00046", "m00047", "m00048", "m00049", "m00050"])
    const result = excludeProtectedRanges(ranges, protectedRefs)
    assert.equal(result.length, 1, "only m00001-m00010 should survive (others start in protected zone)")
    assert.equal(result[0]!.startRef, "m00001")
})

test("excludeProtectedRanges: empty protected set returns all ranges", () => {
    const ranges: CompressibleRange[] = [
        { startRef: "m00001", endRef: "m00010", count: 10, tokens: 5000, toolPct: 50, textPct: 50 },
    ]
    const result = excludeProtectedRanges(ranges, new Set())
    assert.equal(result.length, 1)
})

test("nudge suppressed when all compressible ranges are in protected zone", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    setupRefs(state, 5)

    const config = buildConfig({ maxContextLimit: 500_000, minContextLimit: 50_000 })

    const messages = buildMessages(5, 80_000)

    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "all 5 messages in protected zone (last 20) → nudge suppressed",
    )
})

test("growth hits protected zone only: nudge suppressed even with large growth", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    setupRefs(state, 10)

    const config = buildConfig({ maxContextLimit: 500_000, minContextLimit: 50_000 })

    const messages = buildMessages(10, 20_000)

    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "10 messages × 5K tok = 50K context, all in last 20 → nudge suppressed despite growth",
    )
})

test("partial protection: few unprotected messages → very small compressible list", () => {
    const state = createSessionState()
    setupRefs(state, 25)

    const messages = buildMessages(25, 2000)

    const compress = buildCompress({ preserveRecentMessages: 20, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)

    assert.equal(protectedRefs.size, 20, "20 of 25 messages protected")
    assert.ok(!protectedRefs.has("m00001"), "msg-1 NOT protected")
    assert.ok(!protectedRefs.has("m00005"), "msg-5 NOT protected")
    assert.ok(protectedRefs.has("m00006"), "msg-6 protected (within last 20)")
})

test("partial protection: all messages protected → empty compressible after filtering", () => {
    const state = createSessionState()
    setupRefs(state, 10)

    const messages = buildMessages(10, 2000)

    const compress = buildCompress()
    const protectedRefs = computeProtectedRefs(messages, state, compress)

    const allRanges: CompressibleRange[] = [
        { startRef: "m00001", endRef: "m00005", count: 5, tokens: 2500, toolPct: 0, textPct: 100 },
        { startRef: "m00006", endRef: "m00010", count: 5, tokens: 2500, toolPct: 0, textPct: 100 },
    ]

    const filtered = excludeProtectedRanges(allRanges, protectedRefs)
    assert.equal(filtered.length, 0, "all ranges filtered when all messages are protected")
})

test("edge case: preserveRecentMessages=5 with 8 msgs → only 3 compressible", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 0
    setupRefs(state, 8)

    const config = buildConfig({
        maxContextLimit: 500_000,
        minContextLimit: 50_000,
        preserveRecentMessages: 5,
        preserveRecentTokens: 0,
        preserveLastUserMessage: false,
    })

    const messages = buildMessages(8, 30_000)

    injectCompressNudges(state, config, logger, messages, {} as any)

    const protectedRefs = computeProtectedRefs(messages, state, config.compress)
    assert.equal(protectedRefs.size, 5, "exactly 5 messages protected (msg-4 through msg-8)")
    assert.ok(!protectedRefs.has("m00003"), "msg-3 NOT protected")
    assert.ok(protectedRefs.has("m00004"), "msg-4 protected (within last 5)")
})
