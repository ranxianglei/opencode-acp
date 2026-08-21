import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import {
    buildCompressibleRanges,
    computeProtectedRefs,
    excludeProtectedRanges,
    filterRecommendedRanges,
    EFFECTIVE_MIN_COMPRESSIBLE_TOKENS,
    type CompressibleRange,
} from "../lib/messages/inject/utils"
import { injectCompressNudges } from "../lib/messages/inject/inject"

const SID = "ses-preserve-test"

function buildCompress(p: Partial<PluginConfig["compress"]> = {}): PluginConfig["compress"] {
    return {
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
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: buildCompress(compressOverrides),
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

test("computeProtectedRefs: last user message NOT in hard-protected set (soft-filtered in pipeline)", () => {
    const state = createSessionState()
    setupRefs(state, 50)
    const messages = buildMessages(50, 2000)
    const compress = buildCompress({ preserveRecentMessages: 1, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.ok(protectedRefs.has("m00050"), "last message protected by count")
    assert.ok(!protectedRefs.has("m00049"), "last user message (msg-49) NOT in hard-protected set — soft-filtered by filterLastUserMessage in compress pipeline")
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

test("growth hits protected zone only: nudge suppressed even with real growth", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 0
    setupRefs(state, 10)

    // maxContextLimit=100K → growth threshold = max(5000, 100K * 0.45) = 45K
    // 10 msgs × 20K chars = ~50K tok total → growth = 50K > 45K threshold (passes growth gate)
    // But all 10 msgs are in last-20 protected zone → no compressible ranges → nudge suppressed
    const config = buildConfig({ maxContextLimit: 100_000, minContextLimit: 50_000 })

    const messages = buildMessages(10, 20_000)

    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "growth passes threshold (50K > 45K) but all msgs in protected zone → suppressed by protection",
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

test("excludeProtectedRanges: range extending INTO protected zone is filtered", () => {
    const protectedRefs = new Set(["m00008", "m00009", "m00010"])

    const ranges: CompressibleRange[] = [
        { startRef: "m00001", endRef: "m00005", count: 5, tokens: 2500, toolPct: 0, textPct: 100 },
        { startRef: "m00001", endRef: "m00008", count: 8, tokens: 4000, toolPct: 0, textPct: 100 },
        { startRef: "m00006", endRef: "m00010", count: 5, tokens: 2500, toolPct: 0, textPct: 100 },
        { startRef: "m00008", endRef: "m00010", count: 3, tokens: 1500, toolPct: 0, textPct: 100 },
    ]

    const filtered = excludeProtectedRanges(ranges, protectedRefs)
    assert.equal(filtered.length, 1, "only fully-unprotected range survives")
    assert.equal(filtered[0].startRef, "m00001")
    assert.equal(filtered[0].endRef, "m00005")
})

test("buildCompressibleRanges: splits giant group at protected-zone boundary (autonomous session)", () => {
    const state = createSessionState()
    const messages: WithParts[] = []
    for (let i = 1; i <= 50; i++) {
        const id = `msg-${i}`
        state.messageIds.byRawId.set(id, `m${String(i).padStart(5, "0")}`)
        const role: "user" | "assistant" = i === 1 ? "user" : "assistant"
        messages.push(msg(id, role, "x".repeat(2000)))
    }

    const compress = buildCompress({ preserveRecentMessages: 20, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.ok(protectedRefs.has("m00031"), "msg-31 is first protected (last 20)")
    assert.ok(protectedRefs.has("m00050"), "msg-50 is protected")

    const withoutZone = buildCompressibleRanges(messages, state, [], [])
    const lastRangeWithout = withoutZone.compressible[withoutZone.compressible.length - 1]
    assert.ok(
        lastRangeWithout && protectedRefs.has(lastRangeWithout.endRef),
        "without protectedZoneRefs, last range extends into protected zone (the bug)",
    )

    const withZone = buildCompressibleRanges(messages, state, [], [], protectedRefs)
    for (const r of withZone.compressible) {
        assert.ok(!protectedRefs.has(r.endRef), `range endRef ${r.endRef} must NOT be in protected zone after splitting`)
        assert.ok(!protectedRefs.has(r.startRef), `range startRef ${r.startRef} must NOT be in protected zone after splitting`)
    }
    assert.ok(withZone.compressible.length > 0, "unprotected head produces at least one range")
    assert.ok(
        withZone.compressible.some((r) => r.count >= 10),
        "unprotected head contains a substantial range (10+ msgs)",
    )
})

test("buildCompressibleRanges: all messages in protected zone → no compressible ranges", () => {
    const state = createSessionState()
    const messages: WithParts[] = []
    for (let i = 1; i <= 10; i++) {
        const id = `msg-${i}`
        state.messageIds.byRawId.set(id, `m${String(i).padStart(5, "0")}`)
        const role: "user" | "assistant" = i === 1 ? "user" : "assistant"
        messages.push(msg(id, role, "x".repeat(2000)))
    }

    const compress = buildCompress({ preserveRecentMessages: 20, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.equal(protectedRefs.size, 10, "all 10 messages in protected zone (last 20)")

    const result = buildCompressibleRanges(messages, state, [], [], protectedRefs)
    assert.equal(result.compressible.length, 0, "no compressible ranges when all messages protected")
})

// ─────────────────────────────────────────────────────────────────────
// effectiveTokens accounting (retry-loop fix, issue #37 ses_7fb5cbc8)
// ─────────────────────────────────────────────────────────────────────

test("effectiveTokens: last user message contributes 0 (pipeline soft-filters it)", () => {
    const state = createSessionState()
    // 6 assistants (2000 chars = 500 tok each) + LAST message is a user message
    const messages: WithParts[] = []
    let n = 0
    for (let i = 1; i <= 6; i++) {
        n++
        const id = `msg-${n}`
        state.messageIds.byRawId.set(id, `m${String(n).padStart(5, "0")}`)
        messages.push(msg(id, "assistant", "x".repeat(2000)))
    }
    n++
    const userId = `msg-${n}`
    state.messageIds.byRawId.set(userId, `m${String(n).padStart(5, "0")}`)
    messages.push(msg(userId, "user", "y".repeat(2000)))

    const ranges = buildCompressibleRanges(messages, state, [], [])
    const total = ranges.compressible.reduce((s, r) => s + r.tokens, 0)
    const effective = ranges.compressible.reduce((s, r) => s + r.effectiveTokens, 0)
    assert.equal(total, 7 * 500, "raw tokens count all 7 messages")
    assert.equal(effective, 6 * 500, "effective tokens exclude the last user message")
})

test("effectiveTokens: empty assistant messages contribute 0", () => {
    const state = createSessionState()
    const messages: WithParts[] = []
    // 3 real assistants + 2 empty (whitespace-only text, no tool parts)
    const specs: Array<["user" | "assistant", string]> = [
        ["assistant", "x".repeat(2000)],
        ["assistant", ""],
        ["assistant", "   \n  "],
        ["assistant", "x".repeat(2000)],
        ["user", "z".repeat(2000)],
    ]
    let n = 0
    for (const [role, text] of specs) {
        n++
        const id = `msg-${n}`
        state.messageIds.byRawId.set(id, `m${String(n).padStart(5, "0")}`)
        messages.push(msg(id, role, text))
    }

    const ranges = buildCompressibleRanges(messages, state, [], [])
    const total = ranges.compressible.reduce((s, r) => s + r.tokens, 0)
    const effective = ranges.compressible.reduce((s, r) => s + r.effectiveTokens, 0)
    assert.ok(total > 1000, "raw tokens include whitespace-message padding and user text")
    assert.equal(effective, 2 * 500, "effective counts only the 2 meaningful assistants (empties + last user excluded)")
})

test("regression ses_7fb5cbc8: range of last-user + empties + protected anchors is not recommended", () => {
    // Reconstructs floors 156-175: compress(m00141, m00150) retried ×10 because
    // the nudge kept listing the span, but the pipeline filtered everything:
    // 6 msgs already compressed (pruned from visible list), m00144 = last user
    // message, m00147/m00150 = protected compress anchors, m00148 = empty.
    const state = createSessionState()
    const messages: WithParts[] = []
    let n = 140
    const push = (role: "user" | "assistant", text: string, protectedTool = false) => {
        n++
        const id = `msg-${n}`
        state.messageIds.byRawId.set(id, `m${String(n).padStart(5, "0")}`)
        if (protectedTool) {
            messages.push({
                info: msg(id, role, "").info,
                parts: [{
                    id: `p-${id}`,
                    messageID: id,
                    sessionID: SID,
                    type: "tool" as const,
                    tool: "compress",
                    callID: `call-${id}`,
                    state: { status: "completed", input: {}, output: "Compressed 7 messages" },
                } as any],
            })
        } else {
            messages.push(msg(id, role, text))
        }
    }

    push("assistant", "x".repeat(2000)) // m00141 (visible stand-in for already-compressed remnants)
    push("user", "看看还有哪些pr 列一下 ".repeat(400)) // m00144: last user message (the raw-token bait)
    push("assistant", "") // m00148: empty
    push("assistant", "", true) // m00147: protected compress anchor
    push("assistant", "", true) // m00150: protected compress anchor
    push("assistant", "x".repeat(2000)) // m00151+: loop-generated content (inside protected zone)
    push("assistant", "x".repeat(2000))
    push("assistant", "x".repeat(2000))

    const compress = buildCompress({ preserveRecentMessages: 3, preserveRecentTokens: 0 })
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    const ranges = buildCompressibleRanges(messages, state, ["compress"], [], protectedRefs)
    const unprotected = excludeProtectedRanges(ranges.compressible, protectedRefs)
    const recommended = filterRecommendedRanges(unprotected, ranges.protected, { logger })

    // Raw span tokens look substantial, but effective content (excluding the
    // last user message + empties) falls below the floor → nothing recommended.
    const rawTotal = unprotected.reduce((s, r) => s + r.tokens, 0)
    assert.ok(rawTotal > EFFECTIVE_MIN_COMPRESSIBLE_TOKENS, "raw span tokens exceed the floor (the bait)")
    assert.equal(
        recommended.length,
        0,
        "phantom-prone range must not be recommended after effective accounting",
    )
})

test("regression ses_7fb5cbc8: injectCompressNudges stays silent when all ranges are sub-floor", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 0
    const config = buildConfig({
        maxContextLimit: 100_000,
        minContextLimit: 50_000,
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
    })

    // 3 small assistants (100 effective tokens each) + one huge last user
    // message carrying the bulk of the raw tokens (mirrors the incident:
    // raw context passes the growth gate, but effective compressible content
    // is sub-floor → nothingToCompress → nudge silent).
    const messages: WithParts[] = []
    for (let i = 1; i <= 3; i++) {
        const id = `msg-${i}`
        state.messageIds.byRawId.set(id, `m${String(i).padStart(5, "0")}`)
        messages.push(msg(id, "assistant", "x".repeat(400)))
    }
    state.messageIds.byRawId.set("msg-4", "m00004")
    messages.push(msg("msg-4", "user", "y".repeat(220_000)))

    const before = messages.length
    injectCompressNudges(state, config, logger, messages, {} as any)
    const suffix = suffixText(messages)

    assert.equal(messages.length, before, "no synthetic suffix message left behind")
    assert.ok(!suffix || !suffix.includes("Compressible ranges"), "no range recommendation injected")
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "growth passes the gate but all ranges are sub-floor → nothing worth compressing",
    )
})
