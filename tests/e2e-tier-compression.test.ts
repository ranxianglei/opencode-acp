/**
 * E2E tests for multi-tier compression triggers.
 *
 * Tests simulate the scenario where many T1 compression blocks accumulate
 * over dozens of turns, reaching the threshold for T2 distillation (and
 * eventually T3 condensation). In production this takes 10+ days; here we
 * pre-populate the state with realistic block data to test the trigger
 * logic without waiting.
 *
 * Key behaviors tested:
 * - T2 trigger fires INDEPENDENTLY when T1 summaries reach nudgeGrowthTokens
 * - T2 trigger does NOT fire when T1 summaries are below threshold
 * - T3 trigger fires when T2 summaries reach nudgeGrowthTokens
 * - T2 trigger fires even when T1 nudge is active (independent, not fallback)
 * - T2 trigger respects cadence (growthFloor)
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

const SID = "session-tier-test"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
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
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 60000,
            minContextLimit: 40000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
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

function makeAssistantMessage(id: string, text: string, extraParts?: WithParts["parts"]): WithParts {
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
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: extraParts ? [...baseParts, ...extraParts] : baseParts,
    }
}

function makeCompressionBlock(
    blockId: number,
    summaryTokens: number,
    topic: string,
    tier: 1 | 2 = 1,
    survivedCount: number = 10,
    anchorMessageId: string = "u1",
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: summaryTokens * 60,
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
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: Date.now() - blockId * 60000,
        summary: `[Compressed conversation section]\n## ${topic}\nSummary content for testing (${summaryTokens} tokens).`,
        survivedCount,
        generation: survivedCount >= 5 ? "old" : "young",
        tier,
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

function setupPipeline(
    configOverrides: Partial<PluginConfig> = {},
    stateOverrides: Partial<SessionState> = {},
) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-tier-e2e-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = SID
    Object.assign(state, stateOverrides)

    const config = buildConfig(configOverrides)
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

function getSuffixText(output: { messages: WithParts[] }): string {
    const suffix = output.messages.find((m: WithParts) => isSyntheticMessage(m))
    if (!suffix) return ""
    return suffix.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join("\n")
}

function populateBlocks(
    state: SessionState,
    blocks: CompressionBlock[],
) {
    for (const block of blocks) {
        state.prune.messages.blocksById.set(block.blockId, block)
        state.prune.messages.activeBlockIds.add(block.blockId)
    }
}

// ─── T2 Trigger: fires when T1 summaries reach threshold ────────────────────

test("T2 trigger: fires when T1 summaries exceed nudgeGrowthTokens", async () => {
    // nudgeGrowthTokens for 1M model = ~50K. We set it explicitly to 50000.
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // Pre-populate 10 T1 blocks totaling 60K tokens (>50K threshold)
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 10; i++) {
        blocks.push(makeCompressionBlock(i, 6000, `T1 block ${i}`, 1, 15))
    }
    populateBlocks(state, blocks)

    // Allow tier nudge (lastTier2NudgeTokens undefined = first time)
    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue work"),
            makeAssistantMessage("a1", "Working on it"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    assert.ok(
        suffixText.includes("[Tier 2 Trigger]"),
        `T2 trigger should fire when T1 summaries (60K) exceed threshold (50K). Got suffix:\n${suffixText.slice(0, 500)}`,
    )
    assert.ok(
        suffixText.includes("Distill"),
        "T2 trigger should say 'Distill'",
    )
})

// ─── T2 Trigger: does NOT fire when below threshold ─────────────────────────

test("T2 trigger: does NOT fire when T1 summaries below nudgeGrowthTokens", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // Only 20K of T1 summaries (< 50K threshold)
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 4; i++) {
        blocks.push(makeCompressionBlock(i, 5000, `T1 block ${i}`, 1, 15))
    }
    populateBlocks(state, blocks)

    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    assert.ok(
        !suffixText.includes("[Tier 2 Trigger]"),
        "T2 trigger should NOT fire when T1 summaries (20K) < threshold (50K)",
    )
})

// ─── T2 Trigger: fires INDEPENDENTLY (not gated by T1 nudge) ────────────────

test("T2 trigger: fires even when T1 nudge would also fire (independent)", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
            maxContextLimit: 100000,
            minContextLimit: 80000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // T1 summaries at 60K (triggers T2)
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 10; i++) {
        blocks.push(makeCompressionBlock(i, 6000, `T1 block ${i}`, 1, 15))
    }
    populateBlocks(state, blocks)

    // Set up so T1 nudge would also fire (large context)
    state.nudges.lastPerMessageNudgeTokens = 0

    const output = {
        messages: [
            makeUserMessage("u1", "Big context now"),
            makeAssistantMessage("a1", "x".repeat(100000), [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "c1",
                    id: "p1",
                    sessionID: SID,
                    messageID: "a1",
                    state: {
                        status: "completed",
                        output: "x".repeat(200000),
                        input: {},
                    },
                },
            ]),
            makeUserMessage("u2", "Next"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    // T1 nudge should fire (context is large)
    // T2 nudge should ALSO fire (T1 summaries exceed threshold)
    // Both can appear in the same suffix message
    assert.ok(
        suffixText.includes("[Tier 2 Trigger]"),
        "T2 trigger should fire INDEPENDENTLY of T1 nudge status",
    )
})

// ─── T2 Trigger: respects cadence (growthFloor) ─────────────────────────────

test("T2 trigger: suppressed by cadence when lastTier2NudgeTokens too recent", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // T1 summaries at 60K (> threshold)
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 10; i++) {
        blocks.push(makeCompressionBlock(i, 6000, `T1 block ${i}`, 1, 15))
    }
    populateBlocks(state, blocks)

    // Current context at 200K, but last T2 nudge was at 195K
    // growthFloor = max(5000, 0.45 * 50000) = 22500
    // Growth since last = 200K - 195K = 5K < 22500 → cadence NOT met
    state.nudges.lastTier2NudgeTokens = 195000
    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    assert.ok(
        !suffixText.includes("[Tier 2 Trigger]"),
        "T2 trigger should be suppressed by cadence (growth < growthFloor)",
    )
})

// ─── T3 Trigger: fires when T2 summaries reach threshold ────────────────────

test("T3 trigger: fires when T2 summaries exceed nudgeGrowthTokens", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // T2 summaries at 60K (> threshold), but T1 summaries below threshold
    // (so T2 doesn't fire, only T3)
    const t2Blocks: CompressionBlock[] = []
    for (let i = 1; i <= 6; i++) {
        t2Blocks.push(makeCompressionBlock(i, 10000, `T2 block ${i}`, 2, 20))
    }
    populateBlocks(state, t2Blocks)

    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    assert.ok(
        suffixText.includes("[Tier 3 Trigger]"),
        `T3 trigger should fire when T2 summaries (60K) exceed threshold (50K). Got:\n${suffixText.slice(0, 500)}`,
    )
    assert.ok(
        suffixText.includes("Condense"),
        "T3 trigger should say 'Condense'",
    )
})

// ─── T2 > T3 Priority: when both would trigger, T2 wins ─────────────────────

test("T2 > T3 priority: only T2 fires when both T1 and T2 summaries exceed threshold", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // Both T1 (60K) and T2 (60K) exceed threshold
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 6; i++) {
        blocks.push(makeCompressionBlock(i, 10000, `T1 block ${i}`, 1, 15))
    }
    for (let i = 101; i <= 106; i++) {
        blocks.push(makeCompressionBlock(i, 10000, `T2 block ${i}`, 2, 20))
    }
    populateBlocks(state, blocks)

    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    assert.ok(
        suffixText.includes("[Tier 2 Trigger]"),
        "T2 should take priority when both T1 and T2 summaries exceed threshold",
    )
    assert.ok(
        !suffixText.includes("[Tier 3 Trigger]"),
        "T3 should NOT fire when T2 fires (only one per turn)",
    )
})

// ─── T2 Trigger: generates correct compress range (b→b) ──────────────────────

test("T2 trigger: nudge text contains b→b compress range for oldest blocks", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // Create blocks with varying ages (survivedCount)
    const blocks: CompressionBlock[] = [
        makeCompressionBlock(5, 12000, "Oldest block", 1, 25),
        makeCompressionBlock(8, 11000, "Old block", 1, 20),
        makeCompressionBlock(12, 10000, "Medium block", 1, 15),
        makeCompressionBlock(15, 9000, "Newer block", 1, 10),
        makeCompressionBlock(20, 8000, "Newest block", 1, 5),
    ]
    populateBlocks(state, blocks)

    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    // Should contain block range from oldest to newest
    assert.ok(
        suffixText.includes('startId: "b5"'),
        "Should start from oldest block b5",
    )
    assert.ok(
        suffixText.includes('endId: "b20"'),
        "Should end at newest block b20",
    )
    // Should list all 5 blocks
    assert.ok(suffixText.includes("b5"), "Should list b5")
    assert.ok(suffixText.includes("b8"), "Should list b8")
    assert.ok(suffixText.includes("b12"), "Should list b12")
    assert.ok(suffixText.includes("b15"), "Should list b15")
    assert.ok(suffixText.includes("b20"), "Should list b20")
})

// ─── getTierTokenUsage: correct token counting by tier ──────────────────────

test("getTierTokenUsage: correctly sums tokens by tier", async () => {
    const { getTierTokenUsage } = await import("../lib/state/utils")
    const { state } = setupPipeline()

    populateBlocks(state, [
        makeCompressionBlock(1, 5000, "T1-a", 1),
        makeCompressionBlock(2, 3000, "T1-b", 1),
        makeCompressionBlock(3, 8000, "T2-a", 2),
        makeCompressionBlock(4, 2000, "T2-b", 2),
    ])

    // Mark one as inactive
    const b4 = state.prune.messages.blocksById.get(4)!
    b4.active = false
    state.prune.messages.activeBlockIds.delete(4)

    const usage = getTierTokenUsage(state)
    assert.equal(usage.tier1Tokens, 8000, "T1 = 5000 + 3000")
    assert.equal(usage.tier2Tokens, 8000, "T2 = 8000 (b4 inactive, excluded)")
    assert.equal(usage.tier3Tokens, 0)
})

// ─── Untiered blocks default to tier 1 ──────────────────────────────────────

test("getTierTokenUsage: blocks without tier field default to tier 1", async () => {
    const { getTierTokenUsage } = await import("../lib/state/utils")
    const { state } = setupPipeline()

    const block = makeCompressionBlock(1, 5000, "Legacy block")
    // @ts-expect-error — intentionally remove tier to simulate pre-feature blocks
    delete block.tier
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)

    const usage = getTierTokenUsage(state)
    assert.equal(usage.tier1Tokens, 5000, "Untiered block should count as tier 1")
    assert.equal(usage.tier2Tokens, 0)
})

// ─── Cross-tier safety: nudge narrows range to exclude non-target blocks ──

test("T2 trigger: narrows range when non-target (T2) block sits between T1 candidates", async () => {
    const { state, handler } = setupPipeline({
        compress: {
            ...buildConfig().compress!,
            nudgeGrowthTokens: 50000,
        },
    }, {
        modelContextLimit: 1_000_000,
    })

    // T1 candidates: b5, b6, b7 (before T2) and b12, b13 (after T2)
    // T2 block b10 sits between them — should narrow to one contiguous group
    const blocks: CompressionBlock[] = [
        makeCompressionBlock(5, 12000, "T1-a", 1, 25),
        makeCompressionBlock(6, 12000, "T1-b", 1, 25),
        makeCompressionBlock(7, 12000, "T1-c", 1, 25),
        makeCompressionBlock(10, 5000, "T2 block", 2, 30),
        makeCompressionBlock(12, 12000, "T1-d", 1, 20),
        makeCompressionBlock(13, 12000, "T1-e", 1, 20),
    ]
    populateBlocks(state, blocks)

    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Continue"),
            makeAssistantMessage("a1", "OK"),
        ],
    }

    await handler({}, output)

    const suffixText = getSuffixText(output)
    // T2 trigger should fire (T1 summaries exceed 50K)
    assert.ok(suffixText.includes("[Tier 2 Trigger]"), "T2 trigger should fire")

    // The range should be narrowed — either b5→b7 or b12→b13, NOT b5→b13
    // (which would include the T2 block b10)
    assert.ok(
        !suffixText.includes('endId: "b13"'),
        "Should NOT suggest range ending at b13 (would include T2 b10)",
    )
    assert.ok(
        suffixText.includes('startId: "b5"') && suffixText.includes('endId: "b7"'),
        "Should narrow to first contiguous group b5→b7",
    )
})

// ─── Cross-tier safety: applyCompressionState uses minConsumedTier ─────────

test("applyCompressionState: mixed-tier consumption produces minTier+1, not maxTier+1", async () => {
    const { applyCompressionState } = await import("../lib/compress/state")
    const { state } = setupPipeline()

    // Pre-populate a T2 block that would be "accidentally" consumed
    const t2Block = makeCompressionBlock(10, 3000, "T2 block", 2, 20)
    const t1BlockA = makeCompressionBlock(5, 3000, "T1-a", 1, 15)
    const t1BlockB = makeCompressionBlock(12, 3000, "T1-b", 1, 15)

    populateBlocks(state, [t1BlockA, t2Block, t1BlockB])

    // Simulate a compression that "consumes" all three (as search.ts would
    // if their anchors fell in range)
    const selection = {
        messageIds: ["msg-5", "msg-10", "msg-12"],
        toolIds: [] as string[],
        messageTokenById: new Map([
            ["msg-5", 500],
            ["msg-10", 300],
            ["msg-12", 500],
        ]),
    }

    applyCompressionState(
        state,
        {
            runId: 100,
            mode: "range",
            topic: "T2 compression",
            batchTopic: "T2 compression",
            startId: "b5",
            endId: "b12",
            summaryTokens: 800,
            summary: "distilled summary",
            compressMessageId: "msg-comp-100",
        },
        selection,
        "msg-anchor-100",
        100,
        "distilled summary",
        [5, 10, 12], // consumedBlockIds: T1(5), T2(10), T1(12)
    )

    const newBlock = state.prune.messages.blocksById.get(100)!
    assert.equal(newBlock.tier, 2, "Output tier should be minTier+1=2, not maxTier+1=3")

    // T1 blocks should be deactivated; T2 block should stay active
    const b5 = state.prune.messages.blocksById.get(5)!
    const b10 = state.prune.messages.blocksById.get(10)!
    const b12 = state.prune.messages.blocksById.get(12)!
    assert.equal(b5.active, false, "T1 block b5 should be deactivated")
    assert.equal(b12.active, false, "T1 block b12 should be deactivated")
    assert.equal(b10.active, true, "T2 block b10 should remain active (not consumed)")

    // consumedBlockIds should only include target-tier blocks
    assert.deepEqual(
        newBlock.consumedBlockIds.sort((a, b) => a - b),
        [5, 12],
        "consumedBlockIds should exclude non-target T2 block",
    )
})

// ─── effectiveCompressedTokens: T2+ blocks track full coverage ─────────────

test("applyCompressionState: T2 block gets effectiveCompressedTokens = consumed T1 tokens", async () => {
    const { applyCompressionState } = await import("../lib/compress/state")
    const { state } = setupPipeline()

    // T1 blocks with known compressedTokens
    const t1a = makeCompressionBlock(1, 1000, "T1-a", 1, 10)
    t1a.compressedTokens = 60000
    t1a.effectiveCompressedTokens = 60000
    const t1b = makeCompressionBlock(2, 1000, "T1-b", 1, 10)
    t1b.compressedTokens = 40000
    t1b.effectiveCompressedTokens = 40000

    populateBlocks(state, [t1a, t1b])

    const selection = {
        messageIds: [],
        toolIds: [],
        messageTokenById: new Map(),
    }

    applyCompressionState(
        state,
        {
            runId: 10,
            mode: "range",
            topic: "T2 distillation",
            batchTopic: "T2 distillation",
            startId: "b1",
            endId: "b2",
            summaryTokens: 2000,
            summary: "distilled",
            compressMessageId: "msg-comp-10",
        },
        selection,
        "msg-anchor-10",
        10,
        "distilled",
        [1, 2],
    )

    const t2Block = state.prune.messages.blocksById.get(10)!
    assert.equal(t2Block.tier, 2)
    assert.equal(t2Block.compressedTokens, 0, "T2 direct compressedTokens should be 0")
    assert.equal(
        t2Block.effectiveCompressedTokens,
        100000,
        "effectiveCompressedTokens should be 60000+40000=100000",
    )

    // Stats should use effective tokens
    assert.equal(
        state.stats.totalPruneTokens,
        100000,
        "totalPruneTokens should reflect effective tokens, not 0",
    )
})

// ─── effectiveCompressedTokens: T1 blocks get effectiveCompressedTokens = compressedTokens ──

test("applyCompressionState: T1 block gets effectiveCompressedTokens = compressedTokens", async () => {
    const { applyCompressionState } = await import("../lib/compress/state")
    const { state } = setupPipeline()

    const selection = {
        messageIds: ["m1", "m2", "m3"],
        toolIds: [],
        messageTokenById: new Map([
            ["m1", 500],
            ["m2", 300],
            ["m3", 200],
        ]),
    }

    applyCompressionState(
        state,
        {
            runId: 1,
            mode: "range",
            topic: "T1 compression",
            batchTopic: "T1 compression",
            startId: "m00001",
            endId: "m00003",
            summaryTokens: 100,
            summary: "summary",
            compressMessageId: "msg-comp-1",
        },
        selection,
        "msg-anchor-1",
        1,
        "summary",
        [], // no consumed blocks → T1
    )

    const t1Block = state.prune.messages.blocksById.get(1)!
    assert.equal(t1Block.tier, 1)
    assert.equal(t1Block.compressedTokens, 1000, "compressedTokens from direct messages")
    assert.equal(
        t1Block.effectiveCompressedTokens,
        1000,
        "T1 effectiveCompressedTokens should equal compressedTokens",
    )
})

test("tier-aware decompress: default restores one level up (T2→T1)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "acp-tier-decomp-"))
    const registry = createTestRegistry(tmpDir)
    const logger = new Logger({ level: "error" })
    const config = buildConfig()

    const t1 = makeCompressionBlock(1, 1000, "T1 work", 1, 10, "u1")
    const t2 = makeCompressionBlock(2, 100, "T2 distill", 2, 10, "u2")
    t2.consumedBlockIds = [1]
    t2.directMessageIds = ["msg-comp-1"]
    t2.effectiveMessageIds = [...t1.effectiveMessageIds, "msg-comp-1"]
    t1.active = false

    const state = createSessionState(SID, "test-model", 1_000_000)
    state.prune.messages.blocksById.set(1, t1)
    state.prune.messages.blocksById.set(2, t2)
    state.prune.messages.activeBlockIds.add(2)

    const messages: WithParts[] = [
        makeUserMessage("u1", "original user message"),
        makeAssistantMessage("u2", "t2 compress call"),
    ]

    const { deactivateCompressionTarget } = await import("../lib/compress/decompress-logic")
    const { syncCompressionBlocks } = await import("../lib/messages/sync")

    const target = { displayId: 2, blocks: [t2] }
    deactivateCompressionTarget(state.prune.messages, target)

    syncCompressionBlocks(state, logger, messages)

    assert.equal(t2.active, false, "T2 should be inactive after decompress")
    assert.equal(t1.active, true, "T1 should be reactivated by sync (one level up)")
    assert.equal(t1.deactivatedByUser, false, "T1 should not be deactivatedByUser")

    rmSync(tmpDir, { recursive: true, force: true })
})

test("tier-aware decompress: full:true restores to original (T2→raw)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "acp-tier-decomp-full-"))
    const registry = createTestRegistry(tmpDir)
    const logger = new Logger({ level: "error" })
    const config = buildConfig()

    const t1 = makeCompressionBlock(1, 1000, "T1 work", 1, 10, "u1")
    const t2 = makeCompressionBlock(2, 100, "T2 distill", 2, 10, "u2")
    t2.consumedBlockIds = [1]
    t2.directMessageIds = ["msg-comp-1"]
    t2.effectiveMessageIds = [...t1.effectiveMessageIds, "msg-comp-1"]
    t1.active = false

    const state = createSessionState(SID, "test-model", 1_000_000)
    state.prune.messages.blocksById.set(1, t1)
    state.prune.messages.blocksById.set(2, t2)
    state.prune.messages.activeBlockIds.add(2)

    const messages: WithParts[] = [
        makeUserMessage("u1", "original user message"),
        makeAssistantMessage("u2", "t2 compress call"),
    ]

    const { deactivateCompressionTarget } = await import("../lib/compress/decompress-logic")
    const { syncCompressionBlocks } = await import("../lib/messages/sync")

    const target = { displayId: 2, blocks: [t2] }
    deactivateCompressionTarget(state.prune.messages, target, { full: true })

    syncCompressionBlocks(state, logger, messages)

    assert.equal(t2.active, false, "T2 should be inactive after decompress")
    assert.equal(t1.active, false, "T1 should stay inactive (full decompress to original)")
    assert.equal(t1.deactivatedByUser, true, "T1 marked deactivatedByUser for full mode")

    rmSync(tmpDir, { recursive: true, force: true })
})
