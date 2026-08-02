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
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "compress",
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
    "compress.lastSegmentSoftBlock",
    "compress.preserveRecentMessages",
    "compress.preserveRecentTokens",
    "compress.preserveLastUserMessage",
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
    "qualityGate",
    "qualityGate.enabled",
    "qualityGate.algorithm",
    "qualityGate.algorithms",
    "messageFilters",
    "messageFilters.enabled",
    "messageFilters.filters",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        if (
            fullKey === "compress.modelMaxLimits" ||
            fullKey === "compress.modelMinLimits" ||
            fullKey === "messageFilters.filters"
        ) {
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
            if (emergencyThreshold !== undefined) {
                if (typeof emergencyThreshold === "number") {
                    if (emergencyThreshold < 0) {
                        errors.push({
                            key: "compress.emergencyThresholdPercent",
                            expected: "non-negative number or \"${number}%\" (0–100)",
                            actual: `${emergencyThreshold}`,
                        })
                    }
                } else if (
                    typeof emergencyThreshold === "string" &&
                    emergencyThreshold.endsWith("%")
                ) {
                    const parsed = parseFloat(emergencyThreshold.slice(0, -1))
                    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
                        errors.push({
                            key: "compress.emergencyThresholdPercent",
                            expected: '"${number}%" with percentage in [0, 100]',
                            actual: JSON.stringify(emergencyThreshold),
                        })
                    }
                } else {
                    errors.push({
                        key: "compress.emergencyThresholdPercent",
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(emergencyThreshold),
                    })
                }
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
                compress.lastSegmentSoftBlock !== undefined &&
                typeof compress.lastSegmentSoftBlock !== "boolean"
            ) {
                errors.push({
                    key: "compress.lastSegmentSoftBlock",
                    expected: "boolean",
                    actual: typeof compress.lastSegmentSoftBlock,
                })
            }

            if (
                compress.preserveRecentMessages !== undefined &&
                typeof compress.preserveRecentMessages !== "number"
            ) {
                errors.push({
                    key: "compress.preserveRecentMessages",
                    expected: "number",
                    actual: typeof compress.preserveRecentMessages,
                })
            }

            if (
                typeof compress.preserveRecentMessages === "number" &&
                compress.preserveRecentMessages < 0
            ) {
                errors.push({
                    key: "compress.preserveRecentMessages",
                    expected: "non-negative number (>= 0)",
                    actual: `${compress.preserveRecentMessages}`,
                })
            }

            if (
                compress.preserveRecentTokens !== undefined &&
                typeof compress.preserveRecentTokens !== "number"
            ) {
                errors.push({
                    key: "compress.preserveRecentTokens",
                    expected: "number",
                    actual: typeof compress.preserveRecentTokens,
                })
            }

            if (
                typeof compress.preserveRecentTokens === "number" &&
                compress.preserveRecentTokens < 0
            ) {
                errors.push({
                    key: "compress.preserveRecentTokens",
                    expected: "non-negative number (>= 0)",
                    actual: `${compress.preserveRecentTokens}`,
                })
            }

            if (
                compress.preserveLastUserMessage !== undefined &&
                typeof compress.preserveLastUserMessage !== "boolean"
            ) {
                errors.push({
                    key: "compress.preserveLastUserMessage",
                    expected: "boolean",
                    actual: typeof compress.preserveLastUserMessage,
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

    return errors
}
