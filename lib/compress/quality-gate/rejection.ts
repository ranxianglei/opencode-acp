import type { QualityGateResult } from "./types"

export interface RejectionPlanInfo {
    startId: string
    endId: string
    summary: string
    messageIds: string[]
    messageTokenById: Map<string, number>
}

/**
 * Minimal logging surface for full rejection diagnostics. Kept structural (not
 * the concrete `Logger` class) so tests can inject a plain mock without casting,
 * and so this module has no runtime dependency on the logger implementation.
 */
export interface RejectionDiagnosticsLogger {
    warn(message: string, data?: Record<string, unknown>): void
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

/**
 * Reduce an algorithm-provided reason to its core phrase. The external
 * `context-compress-algorithms` package appends internal threshold/config detail
 * after a colon or inside a parenthetical (e.g. `"Summary too short: 670 chars …
 * (threshold: 200 chars OR 0.5% retention)"`). Only the phrase before the first
 * `:` / `(` is actionable for the model, so everything after it stays out of the
 * model-facing message (#444).
 */
function coreReason(reason: string | undefined): string {
    if (!reason) return "unknown"
    const candidates = [reason.indexOf(":"), reason.indexOf("(")].filter((i) => i >= 0)
    const cut = Math.min(...candidates)
    return (cut > 0 ? reason.slice(0, cut) : reason).trim() || "unknown"
}

export function buildQualityRejectionError(
    plan: RejectionPlanInfo,
    result: QualityGateResult,
    logger?: RejectionDiagnosticsLogger,
): Error {
    const stats = computeStats(plan)

    // Full diagnostics go to the ACP log, NOT the model context. The model only
    // needs enough to act (what failed + how to retry); algorithm-internal
    // metrics and threshold config are diagnostic detail that would otherwise
    // consume context on every rejection (#444).
    logger?.warn("quality gate rejected compression", {
        range: `${plan.startId}–${plan.endId}`,
        reason: result.reason || "unknown",
        layer: result.layer ?? "unknown",
        originalTokens: stats.originalTokens,
        summaryChars: stats.summaryChars,
        ratio: stats.ratio,
        retentionPct: stats.retentionPct,
        rougeF1: formatMetric(result, "rougeF1"),
        top20Recall: formatMetric(result, "top20Recall"),
    })

    const message = `⚠️ COMPRESSION REJECTED — QUALITY GATE FAILURE

Range: ${plan.startId}–${plan.endId}
Reason: ${coreReason(result.reason)}
Original: ~${stats.originalTokens} tokens · Summary: ${stats.summaryChars} chars · Retention: ${stats.retentionPct}%

Retry: write a more complete summary preserving critical details (file paths, decisions, exact values, errors), then call compress again on the same range. If you are confident the summary is adequate despite the metrics, pass "acknowledgeRisk": true.`

    return new Error(message)
}
