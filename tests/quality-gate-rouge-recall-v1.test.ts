import assert from "node:assert/strict"
import test from "node:test"

import { rougeRecallV1, DEFAULT_ROUGE_RECALL_V1_CONFIG } from "../lib/compress/quality-gate/algorithms/rouge-recall-v1"
import type { QualityGateContext } from "../lib/compress/quality-gate/types"
import type { CompressionBlock } from "../lib/state/types"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 50,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "",
        startId: "m001",
        endId: "m010",
        anchorMessageId: "anchor",
        compressMessageId: "compress",
        compressCallId: "call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-1"],
        effectiveToolIds: [],
        createdAt: 0,
        summary: "",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeCtx(
    summary: string,
    originalText: string,
    compressedTokens = 1000,
): QualityGateContext {
    return {
        block: makeBlock({ summary, compressedTokens }),
        summary,
        originalChunks: [originalText],
        originalText,
        originalTokens: Math.ceil(originalText.length / 4),
    }
}

const TEST_CONFIG = {
    layer1MinChars: 1,
    layer1MinRetentionPct: 0,
    layer2MaxRougeF1: 0.05,
    layer2MaxTop20Recall: 0.20,
}

test("rouge-recall-v1: name and version are stable", () => {
    assert.equal(rougeRecallV1.name, "rouge-recall-v1")
    assert.equal(typeof rougeRecallV1.version, "string")
    assert.ok(rougeRecallV1.version.length > 0)
})

test("rouge-recall-v1: description is non-empty", () => {
    assert.ok(rougeRecallV1.description.length > 0)
})

test("DEFAULT_ROUGE_RECALL_V1_CONFIG has expected defaults", () => {
    assert.equal(DEFAULT_ROUGE_RECALL_V1_CONFIG.layer1MinChars, 200)
    assert.equal(DEFAULT_ROUGE_RECALL_V1_CONFIG.layer1MinRetentionPct, 1.0)
    assert.equal(DEFAULT_ROUGE_RECALL_V1_CONFIG.layer2MaxRougeF1, 0.05)
    assert.equal(DEFAULT_ROUGE_RECALL_V1_CONFIG.layer2MaxTop20Recall, 0.20)
})

test("Layer 1 fails on summary shorter than minChars", () => {
    const ctx = makeCtx("short summary", "some longer original content here for testing")
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.equal(result.passed, false)
    assert.equal(result.layer, "L1-length")
    assert.ok(result.reason?.includes("too short"))
})

test("Layer 1 fails on retention below threshold", () => {
    const summary = "x".repeat(250)
    const ctx = makeCtx(summary, "irrelevant text", 100000)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.equal(result.passed, false)
    assert.equal(result.layer, "L1-length")
    assert.ok(result.reason?.includes("retention"))
})

test("Layer 1 passes with summary length >= minChars AND retention >= threshold", () => {
    const summary = "x".repeat(500)
    const ctx = makeCtx(summary, "irrelevant", 1000)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.notEqual(result.layer, "L1-length")
})

test("Layer 1 boundary: summary at exactly minChars with high retention passes", () => {
    const summary = "x".repeat(200)
    const ctx = makeCtx(summary, "y", 100)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.notEqual(result.layer, "L1-length")
})

test("Layer 2 does not run when Layer 1 fails", () => {
    const ctx = makeCtx("tiny", "original content here for testing")
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.equal(result.layer, "L1-length")
    const metricNames = result.metrics.map((m) => m.name)
    assert.ok(!metricNames.includes("rougeF1"))
})

test("Layer 2: passes when rougeF1 high enough", () => {
    const original = "compression pipeline quality gate threshold detection algorithm".repeat(5)
    const summary = "compression pipeline quality gate threshold detection algorithm"
    const ctx = makeCtx(summary, original, 100)
    const result = rougeRecallV1.evaluate(ctx, TEST_CONFIG)
    assert.equal(result.passed, true)
})

test("Layer 2: fails when BOTH rougeF1 AND top20Recall are below thresholds (b27 pattern)", () => {
    // b27 from issue #20: 37 messages about VQ-VAE compressed to a summary
    // that captured none of the technical keywords.
    const original = [
        "VQ-VAE direction approved and experiment launched",
        "hard-NN discontinuity causes gradient blocking",
        "STE training with straight-through estimator",
        "user confirmed direction and approved batch",
        "experiment results show divergence after epoch 50",
    ].join(" ")
    const summary = "## Status\nWork continues. Updates pending further review."
    const ctx = makeCtx(summary, original, 18000)
    const result = rougeRecallV1.evaluate(ctx, TEST_CONFIG)
    assert.equal(result.passed, false)
    assert.equal(result.layer, "L2-recall")
    const metrics = Object.fromEntries(result.metrics.map((m) => [m.name, m.value]))
    assert.ok(metrics.rougeF1 < 0.05, `rougeF1=${metrics.rougeF1}`)
    assert.ok(metrics.top20Recall < 0.20, `top20Recall=${metrics.top20Recall}`)
})

test("Layer 2: passes when rougeF1 low but top20Recall high (b22 pattern)", () => {
    // 20 unique keywords in original; summary covers 4 of them + 200 distractor words.
    // Yields: rougeF1 ~0.036 (low), top20Recall = 0.20 (at threshold).
    // Verifies the AND-combine: low rougeF1 alone does NOT trigger failure when top20Recall is high.
    // An `&&` -> `||` regression in rouge-recall-v1.ts:114 would still pass this test, but
    // paired with the next test (high rougeF1 + low top20Recall) the two together catch it.
    const originalKeywords = Array.from({ length: 20 }, (_, i) => `keyword${String(i + 1).padStart(2, "0")}`)
    const original = originalKeywords.join(" ")
    const distractors = Array.from({ length: 200 }, (_, i) => `distractor${String(i + 1).padStart(3, "0")}`)
    const summary = originalKeywords.slice(0, 4).join(" ") + " " + distractors.join(" ")
    const ctx = makeCtx(summary, original, 20000)
    const result = rougeRecallV1.evaluate(ctx, TEST_CONFIG)
    const metrics = Object.fromEntries(result.metrics.map((m) => [m.name, m.value]))
    assert.ok(metrics.rougeF1 < 0.05, `rougeF1=${metrics.rougeF1} should be < 0.05`)
    assert.ok(metrics.top20Recall >= 0.20, `top20Recall=${metrics.top20Recall} should be >= 0.20`)
    assert.equal(result.passed, true)
})

test("Layer 2: AND-combine — high rougeF1 + low top20Recall does NOT trigger failure", () => {
    // 200 unique tokens in original (all freq=1, so top-20 is alphabetical first 20).
    // Summary covers 30 tokens: only 3 from the top-20 (alphabetically early) + 27 from the tail.
    // Yields: rougeF1 ~0.26 (high, > 0.05), top20Recall = 0.15 (low, < 0.20).
    // An `&&` -> `||` regression in rouge-recall-v1.ts:114 would fail this test (OR would
    // trigger failure on the low top20Recall alone).
    const allTokens = Array.from({ length: 200 }, (_, i) => `token${String(i + 1).padStart(3, "0")}`)
    const original = allTokens.join(" ")
    const summaryTokens = [...allTokens.slice(0, 3), ...allTokens.slice(50, 77)]
    const summary = summaryTokens.join(" ")
    const ctx = makeCtx(summary, original, 100)
    const result = rougeRecallV1.evaluate(ctx, TEST_CONFIG)
    const metrics = Object.fromEntries(result.metrics.map((m) => [m.name, m.value]))
    assert.ok(metrics.rougeF1 >= 0.05, `rougeF1=${metrics.rougeF1} should be >= 0.05`)
    assert.ok(metrics.top20Recall < 0.20, `top20Recall=${metrics.top20Recall} should be < 0.20`)
    assert.equal(result.passed, true)
})

test("Layer 2 metrics include required fields", () => {
    const summary = "x".repeat(500)
    const ctx = makeCtx(summary, "compression pipeline quality gate", 100)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    const names = result.metrics.map((m) => m.name)
    assert.ok(names.includes("summaryLen"))
    assert.ok(names.includes("retentionPct"))
    assert.ok(names.includes("originalTokens"))
    assert.ok(names.includes("rougeF1"))
    assert.ok(names.includes("rougeRecall"))
    assert.ok(names.includes("top20Recall"))
    assert.ok(names.includes("nOriginalPaths"))
    assert.ok(names.includes("nSummaryPaths"))
})

test("Layer 2 does not include pathCoverage when original has < 5 paths", () => {
    const summary = "x".repeat(500)
    const ctx = makeCtx(summary, "compression pipeline quality gate", 100)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    const names = result.metrics.map((m) => m.name)
    assert.ok(!names.includes("pathCoverage"))
})

test("Layer 2 includes pathCoverage when original has >= 5 paths", () => {
    const summary = "x".repeat(500)
    const original = [
        "see lib/foo.ts", "and lib/bar.ts", "plus lib/baz.ts",
        "with src/qux.ts", "and src/quux.ts",
    ].join(" ")
    const ctx = makeCtx(summary, original, 100)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    const names = result.metrics.map((m) => m.name)
    assert.ok(names.includes("pathCoverage"))
    const pathCoverage = result.metrics.find((m) => m.name === "pathCoverage")!
    assert.equal(pathCoverage.value, 0, "summary had no paths, original had 5 -> coverage 0")
})

test("Empty original text passes Layer 1 but skips Layer 2", () => {
    const summary = "x".repeat(500)
    const ctx = makeCtx(summary, "", 100)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.equal(result.passed, true)
    const names = result.metrics.map((m) => m.name)
    assert.ok(!names.includes("rougeF1"), "Layer 2 should be skipped when original is empty")
})

test("Custom config overrides defaults", () => {
    const ctx = makeCtx("short summary", "some original text here", 100)
    const result = rougeRecallV1.evaluate(ctx, {
        ...DEFAULT_ROUGE_RECALL_V1_CONFIG,
        layer1MinChars: 5,
        layer1MinRetentionPct: 0,
    })
    assert.notEqual(result.layer, "L1-length")
})

test("Custom config: invalid layer1MinChars falls back to default", () => {
    const ctx = makeCtx("short", "original", 1000)
    const result = rougeRecallV1.evaluate(ctx, {
        ...DEFAULT_ROUGE_RECALL_V1_CONFIG,
        layer1MinChars: -1,
    })
    assert.equal(result.layer, "L1-length")
})

test("Custom config: undefined config uses all defaults", () => {
    const summary = "x".repeat(500)
    const ctx = makeCtx(summary, "compression pipeline quality gate", 100)
    const result = rougeRecallV1.evaluate(ctx, undefined)
    assert.ok(typeof result.passed === "boolean")
    assert.ok(Array.isArray(result.metrics))
})

test("Mixed EN+ZH content evaluates without error", () => {
    const original = "Compression 压缩 quality 质量 gate 门 detection 检测 algorithm 算法"
    const summary = "压缩压缩压缩质量门检测算法 compression quality gate detection algorithm"
    const ctx = makeCtx(summary, original, 200)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.ok(typeof result.passed === "boolean")
})

test("Reproduces b27 case from issue #20 (catastrophic retention)", () => {
    const original = "VQ-VAE direction approved ".repeat(2000)
    const summary = "## VQ-VAE direction approved, experiment launched"
    const ctx = makeCtx(summary, original, 72000)
    const result = rougeRecallV1.evaluate(ctx, DEFAULT_ROUGE_RECALL_V1_CONFIG)
    assert.equal(result.passed, false)
    assert.equal(result.layer, "L1-length")
    const metrics = Object.fromEntries(result.metrics.map((m) => [m.name, m.value]))
    assert.ok(metrics.retentionPct < 1.0)
})
