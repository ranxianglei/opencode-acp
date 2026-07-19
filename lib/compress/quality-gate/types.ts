import type { CompressionBlock } from "../../state/types"

/**
 * Quality gate framework — pluggable post-compression quality checks.
 *
 * Gates are non-blocking: failures warn via logger, they never reject the
 * compression (the model has already moved on). The framework is designed
 * so that future algorithms (external LLM judges, BERTScore, custom models)
 * can be added by registering a new `QualityGate` implementation.
 */

export interface QualityGateContext {
    block: CompressionBlock
    summary: string
    originalChunks: string[]
    originalText: string
    originalTokens: number
}

export interface QualityGateMetric {
    name: string
    value: number
    format?: "raw" | "percent" | "ratio"
}

export interface QualityGateResult {
    passed: boolean
    layer?: string
    reason?: string
    metrics: QualityGateMetric[]
}

/**
 * Pluggable quality-gate algorithm.
 *
 * Contract:
 * - `name` MUST be globally unique and stable across versions (config refers to it).
 * - `version` SHOULD bump when thresholds or logic change.
 * - `evaluate` MUST NOT throw — on internal error, return `{ passed: true, metrics: [] }`.
 *   Throwing would break the compression pipeline.
 */
export interface QualityGate {
    name: string
    version: string
    description: string
    evaluate(ctx: QualityGateContext, config: unknown): QualityGateResult
}

export interface QualityReport {
    total: number
    passed: number
    failures: Array<{
        blockId: number
        result: QualityGateResult
    }>
}
