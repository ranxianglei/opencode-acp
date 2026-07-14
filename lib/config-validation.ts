/**
 * Pure config validation logic — no runtime dependencies (fs, jsonc-parser, etc.)
 * This module is extracted from config.ts to enable direct unit testing.
 */

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "autoUpdate",
    "debug",
    "showUpdateToasts",
    "pruneNotification",
    "pruneNotificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.minNudgeContextPercent",
    "compress.nudgeGrowthTokens",
    "compress.toolOutputNudgeThreshold",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectTags",
    "compress.protectUserMessages",
    "compress.maxSummaryLengthHard",
    "compress.minCompressRange",
    "compress.minNudgeGrowthRatio",
    "compress.minNudgeGrowthFloor",
    "compress.emergencyThresholdPercent",
    "compress.maxVisibleSegments",
    "compress.keepEmbedMaxChars",
    "gc",
    "gc.algorithm",
    "gc.promotionThreshold",
    "gc.maxBlockAge",
    "gc.maxOldGenSummaryLength",
    "gc.majorGcThresholdPercent",
    "gc.batchCleanup",
    "gc.batchCleanup.lowThreshold",
    "gc.batchCleanup.highThreshold",
    "gc.batchCleanup.forceThreshold",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

export interface ValidationError {
    key: string
    expected: string
    actual: string
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }

    if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean") {
        errors.push({ key: "autoUpdate", expected: "boolean", actual: typeof config.autoUpdate })
    }

    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }

    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    if (config.pruneNotificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.pruneNotificationType)) {
            errors.push({
                key: "pruneNotificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.pruneNotificationType),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v: unknown) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }

        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
        if (typeof config.turnProtection.turns === "number" && config.turnProtection.turns < 1) {
            errors.push({
                key: "turnProtection.turns",
                expected: "positive number (>= 1)",
                actual: `${config.turnProtection.turns}`,
            })
        }
    }

    const experimental = config.experimental
    if (experimental !== undefined) {
        if (
            typeof experimental !== "object" ||
            experimental === null ||
            Array.isArray(experimental)
        ) {
            errors.push({
                key: "experimental",
                expected: "object",
                actual: typeof experimental,
            })
        } else {
            if (
                experimental.allowSubAgents !== undefined &&
                typeof experimental.allowSubAgents !== "boolean"
            ) {
                errors.push({
                    key: "experimental.allowSubAgents",
                    expected: "boolean",
                    actual: typeof experimental.allowSubAgents,
                })
            }

            if (
                experimental.customPrompts !== undefined &&
                typeof experimental.customPrompts !== "boolean"
            ) {
                errors.push({
                    key: "experimental.customPrompts",
                    expected: "boolean",
                    actual: typeof experimental.customPrompts,
                })
            }
        }
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({
                key: "commands",
                expected: "object",
                actual: typeof commands,
            })
        } else {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
            if (commands.protectedTools !== undefined && !Array.isArray(commands.protectedTools)) {
                errors.push({
                    key: "commands.protectedTools",
                    expected: "string[]",
                    actual: typeof commands.protectedTools,
                })
            }
        }
    }

    const manualMode = config.manualMode
    if (manualMode !== undefined) {
        if (typeof manualMode !== "object" || manualMode === null || Array.isArray(manualMode)) {
            errors.push({
                key: "manualMode",
                expected: "object",
                actual: typeof manualMode,
            })
        } else {
            if (manualMode.enabled !== undefined && typeof manualMode.enabled !== "boolean") {
                errors.push({
                    key: "manualMode.enabled",
                    expected: "boolean",
                    actual: typeof manualMode.enabled,
                })
            }

            if (
                manualMode.automaticStrategies !== undefined &&
                typeof manualMode.automaticStrategies !== "boolean"
            ) {
                errors.push({
                    key: "manualMode.automaticStrategies",
                    expected: "boolean",
                    actual: typeof manualMode.automaticStrategies,
                })
            }
        }
    }

    const compress = config.compress
    if (compress !== undefined) {
        if (typeof compress !== "object" || compress === null || Array.isArray(compress)) {
            errors.push({
                key: "compress",
                expected: "object",
                actual: typeof compress,
            })
        } else {
            if (
                compress.mode !== undefined &&
                compress.mode !== "range" &&
                compress.mode !== "message"
            ) {
                errors.push({
                    key: "compress.mode",
                    expected: '"range" | "message"',
                    actual: JSON.stringify(compress.mode),
                })
            }

            if (
                compress.summaryBuffer !== undefined &&
                typeof compress.summaryBuffer !== "boolean"
            ) {
                errors.push({
                    key: "compress.summaryBuffer",
                    expected: "boolean",
                    actual: typeof compress.summaryBuffer,
                })
            }

            if (
                compress.nudgeFrequency !== undefined &&
                typeof compress.nudgeFrequency !== "number"
            ) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "number",
                    actual: typeof compress.nudgeFrequency,
                })
            }

            if (typeof compress.nudgeFrequency === "number" && compress.nudgeFrequency < 1) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "positive number (>= 1)",
                    actual: `${compress.nudgeFrequency} (will be clamped to 1)`,
                })
            }

            if (
                compress.iterationNudgeThreshold !== undefined &&
                typeof compress.iterationNudgeThreshold !== "number"
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "number",
                    actual: typeof compress.iterationNudgeThreshold,
                })
            }

            if (
                compress.nudgeForce !== undefined &&
                compress.nudgeForce !== "strong" &&
                compress.nudgeForce !== "soft"
            ) {
                errors.push({
                    key: "compress.nudgeForce",
                    expected: '"strong" | "soft"',
                    actual: JSON.stringify(compress.nudgeForce),
                })
            }

            if (compress.protectedTools !== undefined && !Array.isArray(compress.protectedTools)) {
                errors.push({
                    key: "compress.protectedTools",
                    expected: "string[]",
                    actual: typeof compress.protectedTools,
                })
            }

            if (compress.protectTags !== undefined && typeof compress.protectTags !== "boolean") {
                errors.push({
                    key: "compress.protectTags",
                    expected: "boolean",
                    actual: typeof compress.protectTags,
                })
            }

            if (
                compress.protectUserMessages !== undefined &&
                typeof compress.protectUserMessages !== "boolean"
            ) {
                errors.push({
                    key: "compress.protectUserMessages",
                    expected: "boolean",
                    actual: typeof compress.protectUserMessages,
                })
            }

            if (
                compress.maxSummaryLengthHard !== undefined &&
                typeof compress.maxSummaryLengthHard !== "number"
            ) {
                errors.push({
                    key: "compress.maxSummaryLengthHard",
                    expected: "number",
                    actual: typeof compress.maxSummaryLengthHard,
                })
            }

            if (
                typeof compress.maxSummaryLengthHard === "number" &&
                compress.maxSummaryLengthHard < 1
            ) {
                errors.push({
                    key: "compress.maxSummaryLengthHard",
                    expected: "positive number (>= 1)",
                    actual: `${compress.maxSummaryLengthHard}`,
                })
            }

            if (
                compress.minCompressRange !== undefined &&
                typeof compress.minCompressRange !== "number"
            ) {
                errors.push({
                    key: "compress.minCompressRange",
                    expected: "number",
                    actual: typeof compress.minCompressRange,
                })
            }

            if (
                typeof compress.minCompressRange === "number" &&
                compress.minCompressRange < 0
            ) {
                errors.push({
                    key: "compress.minCompressRange",
                    expected: "non-negative number (>= 0)",
                    actual: `${compress.minCompressRange}`,
                })
            }

            if (
                compress.minNudgeGrowthRatio !== undefined &&
                typeof compress.minNudgeGrowthRatio !== "number"
            ) {
                errors.push({
                    key: "compress.minNudgeGrowthRatio",
                    expected: "number",
                    actual: typeof compress.minNudgeGrowthRatio,
                })
            }

            if (
                typeof compress.minNudgeGrowthRatio === "number" &&
                (compress.minNudgeGrowthRatio < 0 || compress.minNudgeGrowthRatio > 1)
            ) {
                errors.push({
                    key: "compress.minNudgeGrowthRatio",
                    expected: "number in range [0, 1]",
                    actual: `${compress.minNudgeGrowthRatio}`,
                })
            }

            if (
                compress.minNudgeGrowthFloor !== undefined &&
                typeof compress.minNudgeGrowthFloor !== "number"
            ) {
                errors.push({
                    key: "compress.minNudgeGrowthFloor",
                    expected: "number",
                    actual: typeof compress.minNudgeGrowthFloor,
                })
            }

            if (
                typeof compress.minNudgeGrowthFloor === "number" &&
                compress.minNudgeGrowthFloor < 0
            ) {
                errors.push({
                    key: "compress.minNudgeGrowthFloor",
                    expected: "non-negative number (>= 0)",
                    actual: `${compress.minNudgeGrowthFloor}`,
                })
            }

            const emergencyThreshold = compress.emergencyThresholdPercent
            if (
                emergencyThreshold !== undefined &&
                typeof emergencyThreshold !== "number" &&
                !(typeof emergencyThreshold === "string" && emergencyThreshold.endsWith("%"))
            ) {
                errors.push({
                    key: "compress.emergencyThresholdPercent",
                    expected: 'number | "${number}%"',
                    actual: JSON.stringify(emergencyThreshold),
                })
            }

            if (
                compress.maxVisibleSegments !== undefined &&
                typeof compress.maxVisibleSegments !== "number"
            ) {
                errors.push({
                    key: "compress.maxVisibleSegments",
                    expected: "number",
                    actual: typeof compress.maxVisibleSegments,
                })
            }

            if (
                typeof compress.maxVisibleSegments === "number" &&
                compress.maxVisibleSegments < 1
            ) {
                errors.push({
                    key: "compress.maxVisibleSegments",
                    expected: "positive number (>= 1)",
                    actual: `${compress.maxVisibleSegments}`,
                })
            }

            if (
                compress.keepEmbedMaxChars !== undefined &&
                typeof compress.keepEmbedMaxChars !== "number"
            ) {
                errors.push({
                    key: "compress.keepEmbedMaxChars",
                    expected: "number",
                    actual: typeof compress.keepEmbedMaxChars,
                })
            }

            if (
                typeof compress.keepEmbedMaxChars === "number" &&
                compress.keepEmbedMaxChars < 100
            ) {
                errors.push({
                    key: "compress.keepEmbedMaxChars",
                    expected: "positive number (>= 100)",
                    actual: `${compress.keepEmbedMaxChars}`,
                })
            }

            if (
                typeof compress.iterationNudgeThreshold === "number" &&
                compress.iterationNudgeThreshold < 1
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "positive number (>= 1)",
                    actual: `${compress.iterationNudgeThreshold} (will be clamped to 1)`,
                })
            }

            const validateLimitValue = (
                key: string,
                value: unknown,
                actualValue: unknown = value,
            ): void => {
                const isValidNumber = typeof value === "number"
                const isPercentString = typeof value === "string" && value.endsWith("%")

                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key,
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(actualValue),
                    })
                }
            }

            const validateModelLimits = (
                key: "compress.modelMaxLimits" | "compress.modelMinLimits",
                limits: unknown,
            ): void => {
                if (limits === undefined) {
                    return
                }

                if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
                    errors.push({
                        key,
                        expected: "Record<string, number | ${number}%>",
                        actual: typeof limits,
                    })
                    return
                }

                for (const [providerModelKey, limit] of Object.entries(limits)) {
                    const isValidNumber = typeof limit === "number"
                    const isPercentString =
                        typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
                    if (!isValidNumber && !isPercentString) {
                        errors.push({
                            key: `${key}.${providerModelKey}`,
                            expected: 'number | "${number}%"',
                            actual: JSON.stringify(limit),
                        })
                    }
                }
            }

            if (compress.maxContextLimit !== undefined) {
                validateLimitValue("compress.maxContextLimit", compress.maxContextLimit)
            }

            if (compress.minContextLimit !== undefined) {
                validateLimitValue("compress.minContextLimit", compress.minContextLimit)
            }

            validateModelLimits("compress.modelMaxLimits", compress.modelMaxLimits)
            validateModelLimits("compress.modelMinLimits", compress.modelMinLimits)

            const validValues = ["ask", "allow", "deny"]
            if (compress.permission !== undefined && !validValues.includes(compress.permission)) {
                errors.push({
                    key: "compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(compress.permission),
                })
            }

            if (
                compress.showCompression !== undefined &&
                typeof compress.showCompression !== "boolean"
            ) {
                errors.push({
                    key: "compress.showCompression",
                    expected: "boolean",
                    actual: typeof compress.showCompression,
                })
            }
        }
    }

    const gc = config.gc
    if (gc !== undefined) {
        if (typeof gc !== "object" || gc === null || Array.isArray(gc)) {
            errors.push({
                key: "gc",
                expected: "object",
                actual: typeof gc,
            })
        } else {
            if (gc.algorithm !== undefined && gc.algorithm !== "truncate") {
                errors.push({
                    key: "gc.algorithm",
                    expected: '"truncate"',
                    actual: JSON.stringify(gc.algorithm),
                })
            }
            if (gc.promotionThreshold !== undefined && typeof gc.promotionThreshold !== "number") {
                errors.push({
                    key: "gc.promotionThreshold",
                    expected: "number",
                    actual: typeof gc.promotionThreshold,
                })
            }
            if (gc.maxBlockAge !== undefined && typeof gc.maxBlockAge !== "number") {
                errors.push({
                    key: "gc.maxBlockAge",
                    expected: "number",
                    actual: typeof gc.maxBlockAge,
                })
            }
            if (
                gc.maxOldGenSummaryLength !== undefined &&
                typeof gc.maxOldGenSummaryLength !== "number"
            ) {
                errors.push({
                    key: "gc.maxOldGenSummaryLength",
                    expected: "number",
                    actual: typeof gc.maxOldGenSummaryLength,
                })
            }
            if (
                gc.majorGcThresholdPercent !== undefined
            ) {
                const isValidNumber = typeof gc.majorGcThresholdPercent === "number"
                const isPercentString =
                    typeof gc.majorGcThresholdPercent === "string" &&
                    /^\d+(?:\.\d+)?%$/.test(gc.majorGcThresholdPercent)
                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key: "gc.majorGcThresholdPercent",
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(gc.majorGcThresholdPercent),
                    })
                }
            }

            const validateBatchThreshold = (
                key: "gc.batchCleanup.lowThreshold" | "gc.batchCleanup.highThreshold" | "gc.batchCleanup.forceThreshold",
                value: unknown,
            ): void => {
                const isValidNumber = typeof value === "number"
                const isPercentString = typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)
                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key,
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(value),
                    })
                }
            }

            if (gc.batchCleanup !== undefined) {
                if (
                    typeof gc.batchCleanup !== "object" ||
                    gc.batchCleanup === null ||
                    Array.isArray(gc.batchCleanup)
                ) {
                    errors.push({
                        key: "gc.batchCleanup",
                        expected: "object",
                        actual: typeof gc.batchCleanup,
                    })
                } else {
                    if (gc.batchCleanup.lowThreshold !== undefined) {
                        validateBatchThreshold("gc.batchCleanup.lowThreshold", gc.batchCleanup.lowThreshold)
                    }
                    if (gc.batchCleanup.highThreshold !== undefined) {
                        validateBatchThreshold("gc.batchCleanup.highThreshold", gc.batchCleanup.highThreshold)
                    }
                    if (gc.batchCleanup.forceThreshold !== undefined) {
                        validateBatchThreshold("gc.batchCleanup.forceThreshold", gc.batchCleanup.forceThreshold)
                    }
                }
            }
        }
    }

    const strategies = config.strategies
    if (strategies !== undefined) {
        if (typeof strategies !== "object" || strategies === null || Array.isArray(strategies)) {
            errors.push({
                key: "strategies",
                expected: "object",
                actual: typeof strategies,
            })
        } else {
            const dedup = strategies.deduplication
            if (dedup !== undefined) {
                if (typeof dedup !== "object" || dedup === null || Array.isArray(dedup)) {
                    errors.push({
                        key: "strategies.deduplication",
                        expected: "object",
                        actual: typeof dedup,
                    })
                } else {
                    if (dedup.enabled !== undefined && typeof dedup.enabled !== "boolean") {
                        errors.push({
                            key: "strategies.deduplication.enabled",
                            expected: "boolean",
                            actual: typeof dedup.enabled,
                        })
                    }
                    if (dedup.protectedTools !== undefined && !Array.isArray(dedup.protectedTools)) {
                        errors.push({
                            key: "strategies.deduplication.protectedTools",
                            expected: "string[]",
                            actual: typeof dedup.protectedTools,
                        })
                    }
                }
            }

            const purge = strategies.purgeErrors
            if (purge !== undefined) {
                if (typeof purge !== "object" || purge === null || Array.isArray(purge)) {
                    errors.push({
                        key: "strategies.purgeErrors",
                        expected: "object",
                        actual: typeof purge,
                    })
                } else {
                    if (purge.enabled !== undefined && typeof purge.enabled !== "boolean") {
                        errors.push({
                            key: "strategies.purgeErrors.enabled",
                            expected: "boolean",
                            actual: typeof purge.enabled,
                        })
                    }
                    if (purge.turns !== undefined && typeof purge.turns !== "number") {
                        errors.push({
                            key: "strategies.purgeErrors.turns",
                            expected: "number",
                            actual: typeof purge.turns,
                        })
                    }
                    if (typeof purge.turns === "number" && purge.turns < 1) {
                        errors.push({
                            key: "strategies.purgeErrors.turns",
                            expected: "positive number (>= 1)",
                            actual: `${purge.turns} (will be clamped to 1)`,
                        })
                    }
                    if (purge.protectedTools !== undefined && !Array.isArray(purge.protectedTools)) {
                        errors.push({
                            key: "strategies.purgeErrors.protectedTools",
                            expected: "string[]",
                            actual: typeof purge.protectedTools,
                        })
                    }
                }
            }
        }
    }

    return errors
}
