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
    retentionPct: string
} {
    let originalTokens = 0
    for (const id of plan.messageIds) {
        originalTokens += plan.messageTokenById.get(id) || 0
    }
    const summaryChars = plan.summary.length
    const ratio = originalTokens > 0 ? (originalTokens / Math.max(summaryChars / 4, 1)).toFixed(1) : "?"
    const retentionPct =
        originalTokens > 0 ? ((summaryChars / (originalTokens * 4)) * 100).toFixed(2) : "?"
    return { originalTokens, summaryChars, ratio, retentionPct }
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

${HOW_TO_COMPRESS_RULES}

To retry: rewrite a more complete summary that preserves critical details (file paths, decisions,
exact values, errors). Then add "acknowledgeRisk": true to the compress tool call parameters.
Without acknowledgeRisk: true, the compression will be rejected again.`

    return new Error(message)
}

export function buildPreemptiveAcknowledgeError(): Error {
    return new Error(
        'Parameter "acknowledgeRisk": true was provided, but no quality gate rejection is pending. ' +
            "This parameter is only valid immediately after a compression was rejected by the quality gate. " +
            "Remove it and try again.",
    )
}
