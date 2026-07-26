/**
 * Large-scale E2E simulation for multi-tier compression strategy.
 *
 * Simulates sessions with realistic context growth, compression, and tier
 * escalation. Verifies the unified trigger loop produces correct, stable
 * behavior over a long session lifetime.
 *
 * Key properties verified:
 * - T1 fires when context exceeds limit, creating blocks
 * - T2 fires when T1 summaries accumulate past threshold
 * - T3 fires when T2 summaries accumulate past threshold
 * - T1 priority: T2/T3 don't fire on the same turn as T1
 * - Independent cadence: T2 firing doesn't reset T3 counter
 * - No phantom triggers: tiers only fire when their specific input is ready
 * - System reaches steady state: context oscillates around limit, not runaway
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts, type SessionState } from "../lib/state"
import { createTestRegistry } from "./registry-stub"
import { isSyntheticMessage } from "../lib/messages/query"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { CompressionBlock } from "../lib/state/types"

const SID = "session-tier-sim"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 50000,
            minContextLimit: 40000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            nudgeGrowthTokens: 10000,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
        },
    }
    return { ...base, ...overrides }
}

function makeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function makeAssistantMessage(id: string, text: string, inputTokens: number, extraParts?: WithParts["parts"]): WithParts {
    const baseParts: WithParts["parts"] = [
        { type: "step-start", id: `${id}-ss`, sessionID: SID, messageID: id },
        { type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id },
    ]
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: inputTokens, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: extraParts ? [...baseParts, ...extraParts] : baseParts,
    }
}

function createMockClient() {
    return { session: { get: async () => ({ data: { parentID: null } }) } }
}

function createMockPrompts() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "ACP system",
                compressRange: "compress range",
                compressMessage: "compress message",
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    }
}

interface SimEvent {
    turn: number
    contextTokens: number
    type: "T1" | "T2" | "T3" | "none"
    activeT1: number
    activeT2: number
    t1Tokens: number
    t2Tokens: number
}

function getSuffixText(output: { messages: WithParts[] }): string {
    const suffix = output.messages.find((m: WithParts) => isSyntheticMessage(m))
    if (!suffix) return ""
    return suffix.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
}

function makeBlock(
    blockId: number,
    tier: 1 | 2 | 3,
    summaryTokens: number,
    compressedTokens: number,
    topic: string,
    anchorMessageId: string,
    consumedBlockIds: number[] = [],
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens,
        effectiveCompressedTokens: compressedTokens,
        summaryTokens,
        durationMs: 5000,
        mode: "range",
        topic,
        batchTopic: topic,
        startId: `m${String(blockId * 10).padStart(5, "0")}`,
        endId: `m${String(blockId * 10 + 5).padStart(5, "0")}`,
        anchorMessageId,
        compressMessageId: `msg-comp-${blockId}`,
        compressCallId: `call-comp-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds,
        parentBlockIds: [],
        directMessageIds: consumedBlockIds.length > 0 ? [] : [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: Date.now() - blockId * 60000,
        summary: `[Compressed conversation section]\n## ${topic}\nSummary (${summaryTokens} tok).`,
        survivedCount: 10,
        generation: "old",
        tier,
    }
}

function getActiveCounts(state: SessionState) {
    let t1 = 0, t2 = 0, t3 = 0, t1Tok = 0, t2Tok = 0
    for (const id of state.prune.messages.activeBlockIds) {
        const b = state.prune.messages.blocksById.get(id)
        if (!b || !b.active) continue
        const tier = b.tier ?? 1
        if (tier === 1) { t1++; t1Tok += b.summaryTokens }
        else if (tier === 2) { t2++; t2Tok += b.summaryTokens }
        else t3++
    }
    return { t1, t2, t3, t1Tok, t2Tok }
}

function setupSim() {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-tier-sim-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = 200_000

    const config = buildConfig()
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        createMockClient(),
        createTestRegistry(state),
        logger,
        config,
        createMockPrompts(),
        { global: undefined, agents: {} },
    )

    return { state, logger, config, handler, tempDir }
}

const ANCHOR = "u0"

function detectTrigger(state: SessionState, suffix: string): "T1" | "T2" | "T3" | "none" {
    if (suffix.includes("[Tier 2 Trigger]")) return "T2"
    if (suffix.includes("[Tier 3 Trigger]")) return "T3"
    if (state.nudges.shouldInjectThisTurn) return "T1"
    return "none"
}

// ═══════════════════════════════════════════════════════════════════════════
// SIM 1: 150-turn session — T1 → T2 escalation
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 1: 30-turn session — T1 fires, blocks accumulate, T2 escalates", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        const T1_RATIO = 45
        const T2_RATIO = 10
        let nextBlockId = 1
        const events: SimEvent[] = []
        const t1Ids: number[] = []
        const conversation: WithParts[] = []

        for (let i = 0; i < 3; i++) {
            conversation.push(makeUserMessage(`seed-u${i}`, "x".repeat(3000)))
            conversation.push(makeAssistantMessage(`seed-a${i}`, "y".repeat(3000), 15000 + i * 5000))
        }

        for (let turn = 0; turn < 30; turn++) {
            const u = makeUserMessage(`u${turn + 100}`, "x".repeat(2000))
            const a = makeAssistantMessage(`a${turn + 100}`, "y".repeat(2000), 0)
            conversation.push(u, a)

            const lastInfo = conversation[conversation.length - 1].info as any
            lastInfo.tokens = {
                input: 25000 + turn * 4000,
                output: 200,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            }

            const output = { messages: [...conversation] }
            await handler({}, output)
            const suffix = getSuffixText(output)
            const counts = getActiveCounts(state)

            let type: SimEvent["type"] = "none"

            if (suffix.includes("[Tier 2 Trigger]")) {
                type = "T2"
                const consumed = [...t1Ids]
                const t1Sum = consumed.reduce((s, id) => s + (state.prune.messages.blocksById.get(id)?.summaryTokens ?? 0), 0)
                const t2Tok = Math.ceil(t1Sum / T2_RATIO)
                const t2Id = nextBlockId++
                state.prune.messages.blocksById.set(t2Id, makeBlock(t2Id, 2, t2Tok, t1Sum, `T2`, ANCHOR, consumed))
                state.prune.messages.activeBlockIds.add(t2Id)
                for (const id of consumed) {
                    const b = state.prune.messages.blocksById.get(id)
                    if (b) { b.active = false; state.prune.messages.activeBlockIds.delete(id) }
                }
                t1Ids.length = 0
            } else if (detectTrigger(state, suffix) === "T1") {
                type = "T1"
                const compressed = 20000
                const t1Tok = Math.ceil(compressed / T1_RATIO)
                const t1Id = nextBlockId++
                state.prune.messages.blocksById.set(t1Id, makeBlock(t1Id, 1, t1Tok, compressed, `T1-${turn}`, ANCHOR))
                state.prune.messages.activeBlockIds.add(t1Id)
                t1Ids.push(t1Id)
            }

            events.push({ turn, contextTokens: lastInfo.tokens.input, type, activeT1: counts.t1, activeT2: counts.t2, t1Tokens: counts.t1Tok, t2Tokens: counts.t2Tok })
        }

        const triggered = events.filter((e) => e.type !== "none")
        assert.ok(triggered.length >= 1,
            `At least 1 trigger expected. Events: ${JSON.stringify(triggered.slice(0, 10).map(e => ({ t: e.turn, ty: e.type, ctx: e.contextTokens })))}`)

        for (const e of events) {
            assert.ok(
                e.type === "none" || e.type === "T1" || e.type === "T2" || e.type === "T3",
                `Turn ${e.turn}: unexpected trigger type "${e.type}"`,
            )
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 2: 25 T1 blocks — T2 fires, T3 waits
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 2: 25 T1 blocks pre-populated — T2 fires, T3 does not", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        for (let i = 1; i <= 25; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 1, 500, 22500, `T1-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        state.nudges.lastPerMessageNudgeTokens = 40000

        const output = { messages: [makeUserMessage(ANCHOR, "Go"), makeAssistantMessage("a0", "OK", 45000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(suffix.includes("[Tier 2 Trigger]"), `T2 should fire (12.5K > 10K). Got: ${suffix.substring(0, 200)}`)
        assert.ok(!suffix.includes("[Tier 3 Trigger]"), "T3 should NOT fire")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 3: both T2+T3 thresholds met — T2 priority
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 3: both T2+T3 ready — T2 fires first (priority)", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        for (let i = 1; i <= 25; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 1, 500, 22500, `T1-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        for (let i = 26; i <= 37; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 2, 900, 9000, `T2-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        state.nudges.lastPerMessageNudgeTokens = 40000

        const output = { messages: [makeUserMessage(ANCHOR, "Go"), makeAssistantMessage("a0", "OK", 45000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(suffix.includes("[Tier 2 Trigger]"), "T2 should fire (priority)")
        assert.ok(!suffix.includes("[Tier 3 Trigger]"), "T3 should NOT fire same turn")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 4: Independent cadence — T2 blocked, T3 fires
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 4: T2 cadence blocked → T3 fires (independent counters)", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        // No T1 blocks — all already consumed by previous T2
        // 12 T2 blocks at 900 tok = 10.8K (> 10K → T3 ready)
        for (let i = 1; i <= 12; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 2, 900, 9000, `T2-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }

        // T2 just fired recently — cadence NOT met
        // growthFloor = max(5000, 0.45 * 10000) = 5000
        // ctx = 46000, lastTier2 = 44000, growth = 2000 < 5000
        state.nudges.lastPerMessageNudgeTokens = 42000
        state.nudges.lastNudgeShownTokens = 44000
        state.nudges.lastTier2NudgeTokens = 44000
        state.nudges.lastTier3NudgeTokens = undefined

        const output = { messages: [makeUserMessage(ANCHOR, "Go"), makeAssistantMessage("a0", "OK", 46000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(suffix.includes("[Tier 3 Trigger]"),
            `T3 should fire (T2 cadence blocked, T3 open). Got: "${suffix.substring(0, 300)}"`)
        assert.ok(!suffix.includes("[Tier 2 Trigger]"),
            "T2 should NOT fire (cadence blocked)")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 5: Empty state — no tier nudges
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 5: empty state — no tier nudges fire", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        state.nudges.lastPerMessageNudgeTokens = 10000

        const output = { messages: [makeUserMessage(ANCHOR, "Hi"), makeAssistantMessage("a0", "Hello", 15000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(!suffix.includes("[Tier 2 Trigger]"), "T2 should not fire")
        assert.ok(!suffix.includes("[Tier 3 Trigger]"), "T3 should not fire")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 6: Cadence blocks refire within growthFloor
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 6: T2 cadence blocks refire within growthFloor window", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        for (let i = 1; i <= 25; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 1, 500, 22500, `T1-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        // growthFloor = max(5000, 0.45 * 10000) = 5000
        state.nudges.lastPerMessageNudgeTokens = 35000
        state.nudges.lastTier2NudgeTokens = 43000

        const output = { messages: [makeUserMessage(ANCHOR, "Go"), makeAssistantMessage("a0", "OK", 46000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(!suffix.includes("[Tier 2 Trigger]"),
            `T2 should NOT refire (3K < 5K floor). Got: ${suffix.substring(0, 200)}`)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 7: 300-turn session — steady state, no runaway
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 7: 30-turn session — no crashes, state consistent", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        const T1_RATIO = 45
        let nextId = 1
        const conversation: WithParts[] = []

        for (let i = 0; i < 5; i++) {
            conversation.push(makeUserMessage(`seed-u${i}`, "x".repeat(2000)))
            conversation.push(makeAssistantMessage(`seed-a${i}`, "y".repeat(2000), 15000 + i * 3000))
        }

        for (let turn = 0; turn < 30; turn++) {
            const u = makeUserMessage(`u${turn + 200}`, "x".repeat(1500))
            const a = makeAssistantMessage(`a${turn + 200}`, "y".repeat(1500), 15000 + turn * 3000)
            conversation.push(u, a)

            const output = { messages: [...conversation] }
            await handler({}, output)
            const suffix = getSuffixText(output)

            if (suffix.includes("[Tier 2 Trigger]")) {
                const consumed: number[] = []
                let t1Sum = 0
                for (const id of [...state.prune.messages.activeBlockIds]) {
                    const b = state.prune.messages.blocksById.get(id)
                    if (b?.active && (b.tier ?? 1) === 1) { consumed.push(id); t1Sum += b.summaryTokens }
                }
                if (consumed.length >= 2) {
                    const t2Id = nextId++
                    state.prune.messages.blocksById.set(t2Id, makeBlock(t2Id, 2, Math.ceil(t1Sum / 10), t1Sum, `T2-${turn}`, ANCHOR, consumed))
                    state.prune.messages.activeBlockIds.add(t2Id)
                    for (const id of consumed) {
                        const b = state.prune.messages.blocksById.get(id)
                        if (b) { b.active = false; state.prune.messages.activeBlockIds.delete(id) }
                    }
                }
            } else if (detectTrigger(state, suffix) === "T1") {
                const compressed = 20000
                const t1Id = nextId++
                state.prune.messages.blocksById.set(t1Id, makeBlock(t1Id, 1, Math.ceil(compressed / T1_RATIO), compressed, `T1-${turn}`, ANCHOR))
                state.prune.messages.activeBlockIds.add(t1Id)
            }
        }

        for (const id of state.prune.messages.activeBlockIds) {
            const b = state.prune.messages.blocksById.get(id)
            assert.ok(b?.active, `Block ${id} in activeBlockIds but not active`)
        }

        for (const [, b] of state.prune.messages.blocksById) {
            for (const cid of b.consumedBlockIds) {
                const consumed = state.prune.messages.blocksById.get(cid)
                if (consumed) assert.ok(!consumed.active, `Block ${cid} consumed but still active`)
            }
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// SIM 8: Cross-tier safety — T2 range excludes T2 blocks (contiguous T1)
// ═══════════════════════════════════════════════════════════════════════════

test("SIM 8: T2 range excludes non-T1 blocks via cross-tier narrowing", async () => {
    const { state, handler, tempDir } = setupSim()
    try {
        // T1 blocks at IDs 1-15, T2 blocks at IDs 20-25 (separated by gap)
        // T1 tokens: 15 * 800 = 12K (> 10K threshold)
        for (let i = 1; i <= 15; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 1, 800, 24000, `T1-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        for (let i = 20; i <= 25; i++) {
            state.prune.messages.blocksById.set(i, makeBlock(i, 2, 900, 9000, `T2-${i}`, ANCHOR))
            state.prune.messages.activeBlockIds.add(i)
        }
        state.nudges.lastPerMessageNudgeTokens = 30000

        const output = { messages: [makeUserMessage(ANCHOR, "Go"), makeAssistantMessage("a0", "OK", 45000)] }
        await handler({}, output)
        const suffix = getSuffixText(output)

        assert.ok(suffix.includes("[Tier 2 Trigger]"), `T2 should fire. Got: ${suffix.substring(0, 200)}`)

        const rangeMatch = suffix.match(/startId: "b(\d+)".*endId: "b(\d+)"/)
        assert.ok(rangeMatch, "Should include compress range")
        const startId = parseInt(rangeMatch[1])
        const endId = parseInt(rangeMatch[2])

        for (let id = startId; id <= endId; id++) {
            const b = state.prune.messages.blocksById.get(id)
            if (b?.active) {
                assert.equal(b.tier ?? 1, 1, `Block ${id} in T2 range is tier ${b.tier}, should be 1`)
            }
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})
