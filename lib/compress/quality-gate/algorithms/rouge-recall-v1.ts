import type { QualityGate, QualityGateContext, QualityGateResult, QualityGateMetric } from "../types"
import {
    tokenize,
    rouge1F1,
    rouge1Recall,
    topKRecall,
    extractFilePaths,
} from "../tokenizer"

export interface RougeRecallV1Config {
    layer1MinChars: number
    layer1MinRetentionPct: number
    layer2MaxRougeF1: number
    layer2MaxTop20Recall: number
}

export const DEFAULT_ROUGE_RECALL_V1_CONFIG: RougeRecallV1Config = {
    layer1MinChars: 200,
    layer1MinRetentionPct: 1.0,
    layer2MaxRougeF1: 0.05,
    layer2MaxTop20Recall: 0.20,
}

const TOP_K = 20
const ORIGINAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4

function resolveConfig(input: unknown): RougeRecallV1Config {
    if (!input || typeof input !== "object") return DEFAULT_ROUGE_RECALL_V1_CONFIG
    const c = input as Partial<RougeRecallV1Config>
    return {
        layer1MinChars: typeof c.layer1MinChars === "number" && c.layer1MinChars > 0
            ? c.layer1MinChars : DEFAULT_ROUGE_RECALL_V1_CONFIG.layer1MinChars,
        layer1MinRetentionPct: typeof c.layer1MinRetentionPct === "number" && c.layer1MinRetentionPct >= 0
            ? c.layer1MinRetentionPct : DEFAULT_ROUGE_RECALL_V1_CONFIG.layer1MinRetentionPct,
        layer2MaxRougeF1: typeof c.layer2MaxRougeF1 === "number" && c.layer2MaxRougeF1 >= 0
            ? c.layer2MaxRougeF1 : DEFAULT_ROUGE_RECALL_V1_CONFIG.layer2MaxRougeF1,
        layer2MaxTop20Recall: typeof c.layer2MaxTop20Recall === "number" && c.layer2MaxTop20Recall >= 0
            ? c.layer2MaxTop20Recall : DEFAULT_ROUGE_RECALL_V1_CONFIG.layer2MaxTop20Recall,
    }
}

/**
 * Layer 1 (length gate):
 * - 100% coverage of catastrophic-retention failures (<1% retention)
 * - 0% FPR on healthy summaries (≥5% retention) in calibration (n=6913)
 *
 * Layer 2 (content coverage AND-combine):
 * - Only runs on blocks that PASS Layer 1
 * - Flags if BOTH rougeF1 < threshold AND top20Recall < threshold
 * - AND-combine keeps FPR ~6.6% on healthy summaries while catching
 *   the "long enough but content-empty" failure mode (e.g. 996-char summary
 *   of 5K-token original that captures 0.6% of content words).
 */
export const rougeRecallV1: QualityGate = {
    name: "rouge-recall-v1",
    version: "1.0.0",
    description: "Two-layer gate: length floor (L1) then ROUGE-1 F1 AND top-20 keyword recall (L2)",

    evaluate(ctx: QualityGateContext, rawConfig: unknown): QualityGateResult {
        const cfg = resolveConfig(rawConfig)
        const summaryLen = ctx.summary.length
        const originalChars = ctx.originalText.length
        const retentionPct = originalChars > 0
            ? (summaryLen / (ctx.block.compressedTokens * ORIGINAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN)) * 100
            : 0

        const baseMetrics: QualityGateMetric[] = [
            { name: "summaryLen", value: summaryLen },
            { name: "retentionPct", value: +retentionPct.toFixed(2), format: "percent" },
            { name: "originalTokens", value: ctx.block.compressedTokens },
        ]

        if (
            summaryLen < cfg.layer1MinChars ||
            (originalChars > 0 && retentionPct < cfg.layer1MinRetentionPct)
        ) {
            return {
                passed: false,
                layer: "L1-length",
                reason: `Summary too short: ${summaryLen} chars, ${retentionPct.toFixed(2)}% retention ` +
                    `(threshold: ${cfg.layer1MinChars} chars OR ${cfg.layer1MinRetentionPct}% retention)`,
                metrics: baseMetrics,
            }
        }

        if (ctx.originalText.length === 0) {
            return { passed: true, metrics: baseMetrics }
        }

        const summaryTokens = tokenize(ctx.summary)
        const originalTokens = tokenize(ctx.originalText)
        const rougeF1 = rouge1F1(summaryTokens, originalTokens)
        const rougeRecall = rouge1Recall(summaryTokens, originalTokens)
        const top20 = topKRecall(summaryTokens, originalTokens, TOP_K)

        const summaryPaths = extractFilePaths(ctx.summary)
        const originalPaths = extractFilePaths(ctx.originalText)
        const pathCoverage = originalPaths.size >= 5
            ? [...summaryPaths].filter((p) => originalPaths.has(p)).length / originalPaths.size
            : -1

        const contentMetrics: QualityGateMetric[] = [
            ...baseMetrics,
            { name: "rougeF1", value: +rougeF1.toFixed(4), format: "ratio" },
            { name: "rougeRecall", value: +rougeRecall.toFixed(4), format: "ratio" },
            { name: "top20Recall", value: +top20.toFixed(4), format: "ratio" },
            { name: "nOriginalPaths", value: originalPaths.size },
            { name: "nSummaryPaths", value: summaryPaths.size },
        ]
        if (pathCoverage >= 0) {
            contentMetrics.push({ name: "pathCoverage", value: +pathCoverage.toFixed(3), format: "ratio" })
        }

        if (rougeF1 < cfg.layer2MaxRougeF1 && top20 < cfg.layer2MaxTop20Recall) {
            return {
                passed: false,
                layer: "L2-recall",
                reason: `Content coverage too low: rougeF1=${rougeF1.toFixed(3)}, ` +
                    `top20Recall=${top20.toFixed(3)} ` +
                    `(threshold: rougeF1<${cfg.layer2MaxRougeF1} AND top20<${cfg.layer2MaxTop20Recall})`,
                metrics: contentMetrics,
            }
        }

        return { passed: true, metrics: contentMetrics }
    },
}
