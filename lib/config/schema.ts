import { z } from "zod"

import type { PluginConfig } from "./types"

const commandsSchema = z.object({
    enabled: z.boolean(),
    protectedTools: z.array(z.string()),
})

const manualModeSchema = z.object({
    enabled: z.boolean(),
    automaticStrategies: z.boolean(),
})

const turnProtectionSchema = z.object({
    enabled: z.boolean(),
    turns: z.number().int().min(1),
})

const experimentalSchema = z.object({
    allowSubAgents: z.boolean(),
    customPrompts: z.boolean(),
})

const thresholdSchema = z.union([z.number(), z.string()])

const compressSchema = z.object({
    mode: z.enum(["range", "message"]),
    permission: z.enum(["ask", "allow", "deny"]),
    showCompression: z.boolean(),
    summaryBuffer: z.boolean(),
    maxContextLimit: thresholdSchema,
    minContextLimit: thresholdSchema,
    nudgeFrequency: z.number(),
    iterationNudgeThreshold: z.number(),
    nudgeForce: z.enum(["strong", "soft"]),
    protectedTools: z.array(z.string()),
    protectTags: z.boolean(),
    protectUserMessages: z.boolean(),
    modelMaxLimits: z.record(z.string(), z.number()).optional(),
    modelMinLimits: z.record(z.string(), z.number()).optional(),
})

const deduplicationSchema = z.object({
    enabled: z.boolean(),
    protectedTools: z.array(z.string()),
})

const purgeErrorsSchema = z.object({
    enabled: z.boolean(),
    turns: z.number().int().min(1),
    protectedTools: z.array(z.string()),
})

const strategiesSchema = z.object({
    deduplication: deduplicationSchema,
    purgeErrors: purgeErrorsSchema,
})

const batchCleanupSchema = z.object({
    lowThreshold: z.string(),
    highThreshold: z.string(),
    forceThreshold: z.string(),
})

const gcSchema = z.object({
    algorithm: z.enum(["truncate"]),
    promotionThreshold: z.number(),
    maxBlockAge: z.number(),
    maxOldGenSummaryLength: z.number(),
    majorGcThresholdPercent: z.string(),
    batchCleanup: batchCleanupSchema,
})

export const pluginConfigSchema: z.ZodType<PluginConfig> = z.object({
    enabled: z.boolean(),
    autoUpdate: z.boolean(),
    debug: z.boolean(),
    pruneNotification: z.enum(["off", "minimal", "detailed"]),
    pruneNotificationType: z.enum(["chat", "toast"]),
    commands: commandsSchema,
    manualMode: manualModeSchema,
    turnProtection: turnProtectionSchema,
    experimental: experimentalSchema,
    protectedFilePatterns: z.array(z.string()),
    compress: compressSchema,
    strategies: strategiesSchema,
    gc: gcSchema,
})

/**
 * Strictly validate a complete config object.
 * @throws {z.ZodError} on any violation.
 */
export function validateConfig(obj: unknown): PluginConfig {
    return pluginConfigSchema.parse(obj)
}

/**
 * Leniently type-check a (possibly partial) config object.
 *
 * Does NOT flag missing fields (user fragments are merged with defaults).
 * Surfaces only genuine mistakes: wrong types, invalid enums, range violations,
 * malformed array entries.
 */
export function validateConfigTypes(obj: unknown): { valid: boolean; errors: string[] } {
    const result = pluginConfigSchema.safeParse(obj)
    if (result.success) {
        return { valid: true, errors: [] }
    }

    const errors: string[] = []
    for (const issue of result.error.issues) {
        // Skip diagnostics for absent fields: a partial user config is expected
        // to omit fields that defaults will supply. We detect these by resolving
        // the issue's path against the original input — if the value is
        // undefined, the field is missing (regardless of whether zod reports it
        // as invalid_type for scalars/objects or invalid_value for enums).
        if (isMissingField(obj, issue)) {
            continue
        }
        errors.push(formatIssue(issue))
    }

    return { valid: errors.length === 0, errors }
}

function resolvePath(root: unknown, path: PropertyKey[]): unknown {
    let current: unknown = root
    for (const segment of path) {
        if (current === null || typeof current !== "object") {
            return undefined
        }
        current = (current as Record<PropertyKey, unknown>)[segment]
    }
    return current
}

function isMissingField(root: unknown, issue: z.ZodIssue): boolean {
    return resolvePath(root, issue.path) === undefined
}

function formatIssue(issue: z.ZodIssue): string {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
    return `${path}: ${issue.message}`
}
