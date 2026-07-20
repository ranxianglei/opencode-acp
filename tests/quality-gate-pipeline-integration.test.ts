import assert from "node:assert/strict"
import test from "node:test"

import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts, type CompressionBlock } from "../lib/state"
import { evaluateBatchQuality, evaluateBlockQuality } from "../lib/compress/quality-gate"
import { registerQualityGate, clearQualityGateRegistryForTests, listQualityGates } from "../lib/compress/quality-gate/registry"
import { ensureBuiltinGatesRegistered } from "../lib/compress/quality-gate/algorithms"
import type { QualityGate } from "../lib/compress/quality-gate/types"
import type { NotificationEntry } from "../lib/compress/pipeline"

const STUB_GATE_NAME = "test-stub-v1"

const stubGate: QualityGate = {
    name: STUB_GATE_NAME,
    version: "1.0.0",
    description: "Stub gate for pipeline integration tests — fails L1 when summary < minChars",

    evaluate(ctx, rawConfig) {
        const cfg = (rawConfig as { minChars?: number } | null | undefined)
        const minChars = cfg?.minChars ?? 200
        const metrics = [
            { name: "summaryLen", value: ctx.summary.length },
            { name: "originalTokens", value: ctx.block.compressedTokens },
        ]
        if (ctx.originalText.length > 0) {
            metrics.push({ name: "stubMetric", value: 0.5, format: "ratio" as const })
        }
        if (ctx.summary.length < minChars) {
            return {
                passed: false,
                layer: "L1-length",
                reason: `Summary too short: ${ctx.summary.length} chars (threshold: ${minChars})`,
                metrics,
            }
        }
        return { passed: true, metrics }
    },
}

function buildConfig(qualityGateEnabled: boolean): PluginConfig {
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
            maxContextLimit: 150000,
            minContextLimit: 50000,
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
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: qualityGateEnabled,
            algorithm: STUB_GATE_NAME,
            algorithms: {
                [STUB_GATE_NAME]: {
                    minChars: 200,
                },
            },
        },
    }
}

function makeBlock(blockId: number, summary: string, directMessageIds: string[], compressedTokens = 1000): CompressionBlock {
    return {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens,
        summaryTokens: Math.ceil(summary.length / 4),
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "",
        startId: "m001",
        endId: "m010",
        anchorMessageId: "anchor",
        compressMessageId: "compress",
        compressCallId: `call-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds,
        directToolIds: [],
        effectiveMessageIds: directMessageIds,
        effectiveToolIds: [],
        createdAt: 0,
        summary,
        survivedCount: 0,
        generation: "young",
    }
}

function makeTextMessage(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionId: "test" } as any,
        parts: [{ type: "text", text }],
    } as any
}

function installBlock(state: ReturnType<typeof createSessionState>, block: CompressionBlock): void {
    state.prune.messages.blocksById.set(block.blockId, block)
    for (const mid of block.directMessageIds) {
        state.prune.messages.byMessageId.set(mid, {
            activeBlockIds: [block.blockId],
            allBlockIds: [block.blockId],
        })
    }
}

const logger = new Logger(false)

test("evaluateBlockQuality returns null when qualityGate disabled", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const block = makeBlock(1, "short", ["msg-1"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "original content")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "short", summaryTokens: 2 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(false), logger)
    assert.equal(result, null)
})

test("evaluateBlockQuality runs gate when enabled", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(50), ["msg-1"], 10000)
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "original content with technical keywords")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(50), summaryTokens: 13 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(true), logger)
    assert.ok(result, "should produce a result when enabled")
    assert.equal(result!.passed, false, "50-char summary below 200 threshold should fail L1")
    assert.equal(result!.layer, "L1-length")
})

test("evaluateBlockQuality returns null when block not in state", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const rawMessages: WithParts[] = []
    const entry: NotificationEntry = { blockId: 999, runId: 1, summary: "missing", summaryTokens: 2 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(true), logger)
    assert.equal(result, null)
})

test("evaluateBlockQuality returns null when block has no direct messages", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(500), [])
    installBlock(state, block)
    const rawMessages: WithParts[] = []
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(500), summaryTokens: 125 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(true), logger)
    assert.equal(result, null, "blocks with no direct messages have no original to compare")
})

test("evaluateBlockQuality handles missing raw messages gracefully", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const summary = "first message available only summary preserved across missing parts".repeat(3)
    const block = makeBlock(1, summary, ["msg-1", "msg-2"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "only first message available")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary, summaryTokens: 60 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(true), logger)
    assert.ok(result, "should still evaluate with partial messages")
    assert.equal(result!.passed, true, "summary > 200 chars so passes L1")
})

test("evaluateBlockQuality extracts tool-call content from messages", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(500), ["msg-1"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [
        {
            info: { id: "msg-1", role: "assistant", sessionId: "test" } as any,
            parts: [
                { type: "text", text: "Running ls to inspect" },
                {
                    type: "tool",
                    tool: "bash",
                    state: {
                        input: { command: "ls -la" },
                        output: "file1.txt\nfile2.txt\ncompression pipeline algorithm",
                    },
                },
            ],
        } as any,
    ]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(500), summaryTokens: 125 }

    const result = evaluateBlockQuality(state, rawMessages, entry, buildConfig(true), logger)
    assert.ok(result)
    const metrics = Object.fromEntries(result!.metrics.map((m) => [m.name, m.value]))
    assert.ok(metrics.stubMetric !== undefined, "L2 metrics should be present when originalText is non-empty")
})

test("evaluateBatchQuality: empty entries → empty report", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const report = evaluateBatchQuality(state, [], [], buildConfig(true), logger)
    assert.equal(report.total, 0)
    assert.equal(report.passed, 0)
    assert.equal(report.failures.length, 0)
})

test("evaluateBatchQuality: all-passing entries → no failures", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const longSummary = "x".repeat(500)
    const block1 = makeBlock(1, longSummary, ["msg-1"], 100)
    const block2 = makeBlock(2, longSummary, ["msg-2"], 100)
    installBlock(state, block1)
    installBlock(state, block2)
    const rawMessages: WithParts[] = [
        makeTextMessage("msg-1", "original content"),
        makeTextMessage("msg-2", "original content"),
    ]
    const entries: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: longSummary, summaryTokens: 125 },
        { blockId: 2, runId: 1, summary: longSummary, summaryTokens: 125 },
    ]

    const report = evaluateBatchQuality(state, rawMessages, entries, buildConfig(true), logger)
    assert.equal(report.total, 2)
    assert.equal(report.passed, 2)
    assert.equal(report.failures.length, 0)
})

test("evaluateBatchQuality: failing entries → reported with blockId", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const failingSummary = "x".repeat(50)
    const block1 = makeBlock(1, failingSummary, ["msg-1"], 50000)
    const block2 = makeBlock(2, failingSummary, ["msg-2"], 50000)
    installBlock(state, block1)
    installBlock(state, block2)
    const rawMessages: WithParts[] = [
        makeTextMessage("msg-1", "original technical content with keywords"),
        makeTextMessage("msg-2", "different original content with other keywords"),
    ]
    const entries: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: failingSummary, summaryTokens: 13 },
        { blockId: 2, runId: 1, summary: failingSummary, summaryTokens: 13 },
    ]

    const report = evaluateBatchQuality(state, rawMessages, entries, buildConfig(true), logger)
    assert.equal(report.total, 2)
    assert.equal(report.passed, 0)
    assert.equal(report.failures.length, 2)
    assert.deepEqual(
        report.failures.map((f) => f.blockId).sort((a, b) => a - b),
        [1, 2],
    )
    for (const failure of report.failures) {
        assert.equal(failure.result.layer, "L1-length")
        assert.ok(failure.result.reason?.includes("too short"))
    }
})

test("evaluateBatchQuality: mixed pass/fail entries → only failures reported", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const goodSummary = "x".repeat(500)
    const badSummary = "x".repeat(50)
    const block1 = makeBlock(1, goodSummary, ["msg-1"], 100)
    const block2 = makeBlock(2, badSummary, ["msg-2"], 50000)
    installBlock(state, block1)
    installBlock(state, block2)
    const rawMessages: WithParts[] = [
        makeTextMessage("msg-1", "original content"),
        makeTextMessage("msg-2", "unrelated content"),
    ]
    const entries: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: goodSummary, summaryTokens: 125 },
        { blockId: 2, runId: 1, summary: badSummary, summaryTokens: 13 },
    ]

    const report = evaluateBatchQuality(state, rawMessages, entries, buildConfig(true), logger)
    assert.equal(report.total, 2)
    assert.equal(report.passed, 1)
    assert.equal(report.failures.length, 1)
    assert.equal(report.failures[0].blockId, 2)
})

test("evaluateBatchQuality: gate disabled → all entries counted as passed, no evaluation", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(stubGate)
    const state = createSessionState()
    const block = makeBlock(1, "tiny", ["msg-1"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "content")]
    const entries: NotificationEntry[] = [
        { blockId: 1, runId: 1, summary: "tiny", summaryTokens: 1 },
    ]

    const report = evaluateBatchQuality(state, rawMessages, entries, buildConfig(false), logger)
    assert.equal(report.total, 1)
    assert.equal(report.passed, 1)
    assert.equal(report.failures.length, 0)
})

test("evaluateBlockQuality returns null when algorithm not registered", () => {
    clearQualityGateRegistryForTests()
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(500), ["msg-1"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "content")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(500), summaryTokens: 125 }

    const cfg = buildConfig(true)
    cfg.qualityGate!.algorithm = "nonexistent-algorithm"

    const result = evaluateBlockQuality(state, rawMessages, entry, cfg, logger)
    assert.equal(result, null, "missing algorithm in registry should return null (logged as warning)")
})

test("evaluateBlockQuality treats a throwing gate as pass (defensive)", () => {
    clearQualityGateRegistryForTests()
    const throwingGate: QualityGate = {
        name: "throwing-stub",
        version: "1.0.0",
        description: "Stub that throws — pipeline must treat as pass",
        evaluate() {
            throw new Error("synthetic throw from gate")
        },
    }
    registerQualityGate(throwingGate)
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(500), ["msg-1"])
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "content")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(500), summaryTokens: 125 }

    const cfg = buildConfig(true)
    cfg.qualityGate!.algorithm = "throwing-stub"

    const result = evaluateBlockQuality(state, rawMessages, entry, cfg, logger)
    assert.ok(result)
    assert.equal(result!.passed, true, "throwing gate must be treated as pass to not break pipeline")
    assert.equal(result!.metrics.length, 0)
})

test("ensureBuiltinGatesRegistered auto-registers rouge-recall-v1 from context-compress-algorithms", () => {
    clearQualityGateRegistryForTests()
    ensureBuiltinGatesRegistered()
    const registered = listQualityGates()
    assert.ok(registered.includes("rouge-recall-v1"), "rouge-recall-v1 should be auto-registered from context-compress-algorithms package")

    ensureBuiltinGatesRegistered()
    const stillOnce = listQualityGates().filter((n) => n === "rouge-recall-v1").length
    assert.equal(stillOnce, 1, "double-init should not duplicate registration")
})

test("evaluateBlockQuality end-to-end with real rouge-recall-v1 from context-compress-algorithms", () => {
    clearQualityGateRegistryForTests()
    ensureBuiltinGatesRegistered()
    const state = createSessionState()
    const block = makeBlock(1, "x".repeat(50), ["msg-1"], 10000)
    installBlock(state, block)
    const rawMessages: WithParts[] = [makeTextMessage("msg-1", "original content with technical keywords")]
    const entry: NotificationEntry = { blockId: 1, runId: 1, summary: "x".repeat(50), summaryTokens: 13 }

    const cfg = buildConfig(true)
    cfg.qualityGate!.algorithm = "rouge-recall-v1"
    cfg.qualityGate!.algorithms = {
        "rouge-recall-v1": {
            layer1MinChars: 200,
            layer1MinRetentionPct: 1.0,
            layer2MaxRougeF1: 0.05,
            layer2MaxTop20Recall: 0.20,
        },
    }

    const result = evaluateBlockQuality(state, rawMessages, entry, cfg, logger)
    assert.ok(result, "real rouge-recall-v1 should evaluate")
    assert.equal(result!.passed, false, "50-char summary of 10K original fails L1")
    assert.equal(result!.layer, "L1-length")
    assert.ok(result!.reason?.includes("too short"))
})
