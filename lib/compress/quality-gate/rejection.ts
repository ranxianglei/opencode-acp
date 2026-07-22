import { HOW_TO_COMPRESS_RULES } from "context-compress-algorithms/prompts"
import type { QualityGateResult } from "./types"

export interface RejectionPlanInfo {
    startId: string
    endId: string
    summary: string
    messageIds: string[]
    messageTokenById: Map<string, number>
}

function formatMetric(result: QualityGateResult, name: string): string {
    const m = result.metrics.find((x) => x.name === name)
    if (!m) return "?"
    switch (m.format) {
        case "percent":
            return `${m.value.toFixed(2)}%`
        case "ratio":
            return m.value.toFixed(4)
        default:
            return String(m.value)
    }
}

function computeStats(plan: RejectionPlanInfo): {
    originalTokens: number
    summaryChars: number
    ratio: string
    ratioNum: number | null
    retentionPct: string
} {
    let originalTokens = 0
    for (const id of plan.messageIds) {
        originalTokens += plan.messageTokenById.get(id) || 0
    }
    const summaryChars = plan.summary.length
    const ratioNum =
        originalTokens > 0 ? originalTokens / Math.max(summaryChars / 4, 1) : null
    const ratio = ratioNum !== null ? ratioNum.toFixed(1) : "?"
    const retentionPct =
        originalTokens > 0 ? ((summaryChars / (originalTokens * 4)) * 100).toFixed(2) : "?"
    return { originalTokens, summaryChars, ratio, ratioNum, retentionPct }
}

// A range this large cannot be summarized densely enough in one pass: the L1
// retention floor (1% of originalTokens*4 chars) would demand a multi-thousand
// char summary. At this size, splitting is the correct recovery, not rewriting.
const LARGE_RANGE_TOKENS = 50_000

function buildRecoveryGuidance(stats: ReturnType<typeof computeStats>): string {
    const isLargeRange = stats.originalTokens > LARGE_RANGE_TOKENS

    const escapeHatches = `If the hard length limit is too tight for important detail, pass "summaryMaxChars" (e.g. 12000) to raise the cap.
As a LAST RESORT only — after you have genuinely tried the above — add "acknowledgeRisk": true to accept the information loss and force the compression through. Without acknowledgeRisk: true on the retry, the compression will be rejected again.`

    if (isLargeRange) {
        return `HOW TO RECOVER — SPLIT THE RANGE

This range is very large (~${stats.originalTokens} tokens). A single summary almost cannot be dense
enough to pass the retention floor — the failure is structural, not a wording problem.
Do NOT resubmit the same range with a slightly longer summary. Instead:

1. SPLIT this range into 2-3 smaller contiguous ranges (e.g. first half, second half) and
   compress each one separately in the SAME batch "compress" call — give each its own "topic"
   and "summary". Smaller ranges are far easier to summarize densely.
2. Only if a sub-range is still rejected, rewrite THAT smaller summary to be denser (full file
   paths, signatures, exact errors, decisions + rationale).

${escapeHatches}`
    }

    return `HOW TO RECOVER — WRITE A DENSER SUMMARY

The range is small enough that one summary can pass. Rewrite it to preserve every load-bearing
detail: full file paths with line numbers, function/type signatures, exact error strings,
decisions WITH their rationale, exact values. Strip only true noise (verbose logs, duplicate
reads, spent exploration).

${escapeHatches}`
}

export function buildQualityRejectionError(
    plan: RejectionPlanInfo,
    result: QualityGateResult,
): Error {
    const stats = computeStats(plan)
    const metrics = [
        `Original: ~${stats.originalTokens} tokens`,
        `Summary: ${stats.summaryChars} chars`,
        `Ratio: ${stats.ratio}:1`,
        `Retention: ${stats.retentionPct}%`,
        `Gate layer: ${result.layer ?? "unknown"}`,
        `rougeF1: ${formatMetric(result, "rougeF1")}`,
        `top20Recall: ${formatMetric(result, "top20Recall")}`,
    ]

    const message = `⚠️ COMPRESSION REJECTED — QUALITY GATE FAILURE

Range: ${plan.startId}–${plan.endId}
${metrics.join("\n")}

⚠️ CRITICAL: Compression is the ONLY mechanism for preserving historical context in this session.
Once a compression is accepted, the original messages are permanently removed from visible context.
Your summary becomes the SOLE record. If it fails, subsequent work is built on a broken foundation —
memory loss → wrong assumptions → entire reasoning chain collapse.
Treat every compression with maximum care.

${buildRecoveryGuidance(stats)}

${HOW_TO_COMPRESS_RULES}`

    return new Error(message)
}
