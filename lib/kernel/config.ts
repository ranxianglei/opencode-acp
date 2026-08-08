import { defaultConfig, type Config } from "acp-kernel"
import type { PluginConfig } from "../config"

// Map opencode-acp's three-layer PluginConfig onto acp-kernel's Config. The
// kernel is the single source of truth for thresholds/triggers once wired
// (Phase 2); this resolver keeps the user-facing config surface (acp.jsonc,
// dcp.schema.json, /acp commands) unchanged. See devlog DESIGN.md §3.

function parsePercent(value: number | `${number}%` | undefined, fallback: number): number {
    if (typeof value === "number") return value
    if (typeof value === "string") {
        const match = value.match(/^(\d+(?:\.\d+)?)%$/)
        if (match) return Number.parseFloat(match[1]!) / 100
    }
    return fallback
}

const FALLBACK_MODEL_LIMIT = 150_000

export function resolveKernelConfig(plugin: PluginConfig, modelContextLimit: number | undefined): Config {
    const limit = modelContextLimit && modelContextLimit > 0 ? modelContextLimit : FALLBACK_MODEL_LIMIT
    const compress = plugin.compress

    // "compress" is force-protected regardless of user config: its summary
    // parameter is the sole record of compressed conversation and cannot be
    // recovered if a later compression eats it (AGENTS.md §2.6, Bug history).
    const protectedTools = new Set<string>(compress.protectedTools)
    protectedTools.add("compress")

    const growthRatio = compress.nudgeGrowthTokens && limit > 0 ? compress.nudgeGrowthTokens / limit : 0.05

    return defaultConfig(limit, {
        protectedTools: [...protectedTools],
        preserveRecentMessages: compress.preserveRecentMessages ?? 5,
        preserveRecentTokens: compress.preserveRecentTokens ?? 5000,
        promotionThreshold: plugin.gc.promotionThreshold,
        nudge: {
            maxContextLimitPct: parsePercent(compress.maxContextLimit, 0.55),
            minContextLimitPct: parsePercent(compress.minContextLimit, 0.45),
            frequency: compress.nudgeFrequency,
            iterationThreshold: compress.iterationNudgeThreshold,
            force: compress.nudgeForce,
            growthRatio,
            growthFloor: 6000,
            growthCap: 50000,
            minGrowthFloor: compress.minNudgeGrowthFloor,
            minGrowthRatio: compress.minNudgeGrowthRatio,
            emergencyThresholdPct: parsePercent(compress.emergencyThresholdPercent, 0.98),
        },
        truncate: {
            threshold: parsePercent(plugin.gc.majorGcThresholdPercent, 1.0),
        },
        compress: {
            minCompressRange: compress.minCompressRange,
            maxSummaryLength: compress.maxSummaryLengthHard,
            minSummaryLength: 50,
        },
    })
}
