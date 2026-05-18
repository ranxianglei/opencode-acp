import assert from "node:assert/strict"
import test from "node:test"

const VALID_CONFIG_KEYS = new Set([
    "$schema", "enabled", "autoUpdate", "debug", "showUpdateToasts",
    "pruneNotification", "pruneNotificationType",
    "turnProtection", "turnProtection.enabled", "turnProtection.turns",
    "experimental", "experimental.allowSubAgents", "experimental.customPrompts",
    "protectedFilePatterns",
    "commands", "commands.enabled", "commands.protectedTools",
    "manualMode", "manualMode.enabled", "manualMode.automaticStrategies",
    "compress", "compress.mode", "compress.permission", "compress.showCompression",
    "compress.summaryBuffer", "compress.maxContextLimit", "compress.minContextLimit",
    "compress.modelMaxLimits", "compress.modelMinLimits",
    "compress.nudgeFrequency", "compress.iterationNudgeThreshold",
    "compress.nudgeForce", "compress.protectedTools",
    "compress.protectTags", "compress.protectUserMessages",
    "gc", "gc.algorithm", "gc.promotionThreshold", "gc.maxBlockAge",
    "gc.maxOldGenSummaryLength", "gc.majorGcThresholdPercent",
    "strategies", "strategies.deduplication", "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors", "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns", "strategies.purgeErrors.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") continue
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

interface ValidationError { key: string; expected: string; actual: string }

function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean")
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })

    if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean")
        errors.push({ key: "autoUpdate", expected: "boolean", actual: typeof config.autoUpdate })

    if (config.debug !== undefined && typeof config.debug !== "boolean")
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })

    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification))
            errors.push({ key: "pruneNotification", expected: '"off" | "minimal" | "detailed"', actual: JSON.stringify(config.pruneNotification) })
    }

    if (config.pruneNotificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.pruneNotificationType))
            errors.push({ key: "pruneNotificationType", expected: '"chat" | "toast"', actual: JSON.stringify(config.pruneNotificationType) })
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns))
            errors.push({ key: "protectedFilePatterns", expected: "string[]", actual: typeof config.protectedFilePatterns })
        else if (!config.protectedFilePatterns.every((v: unknown) => typeof v === "string"))
            errors.push({ key: "protectedFilePatterns", expected: "string[]", actual: "non-string entries" })
    }

    if (config.turnProtection) {
        if (config.turnProtection.enabled !== undefined && typeof config.turnProtection.enabled !== "boolean")
            errors.push({ key: "turnProtection.enabled", expected: "boolean", actual: typeof config.turnProtection.enabled })
        if (config.turnProtection.turns !== undefined && typeof config.turnProtection.turns !== "number")
            errors.push({ key: "turnProtection.turns", expected: "number", actual: typeof config.turnProtection.turns })
        if (typeof config.turnProtection.turns === "number" && config.turnProtection.turns < 1)
            errors.push({ key: "turnProtection.turns", expected: "positive number (>= 1)", actual: `${config.turnProtection.turns}` })
    }

    const compress = config.compress
    if (compress !== undefined && typeof compress === "object" && compress !== null && !Array.isArray(compress)) {
        if (compress.mode !== undefined && compress.mode !== "range" && compress.mode !== "message")
            errors.push({ key: "compress.mode", expected: '"range" | "message"', actual: JSON.stringify(compress.mode) })
        if (compress.permission !== undefined && !["ask", "allow", "deny"].includes(compress.permission))
            errors.push({ key: "compress.permission", expected: '"ask" | "allow" | "deny"', actual: JSON.stringify(compress.permission) })
        if (compress.nudgeForce !== undefined && compress.nudgeForce !== "strong" && compress.nudgeForce !== "soft")
            errors.push({ key: "compress.nudgeForce", expected: '"strong" | "soft"', actual: JSON.stringify(compress.nudgeForce) })
        if (compress.summaryBuffer !== undefined && typeof compress.summaryBuffer !== "boolean")
            errors.push({ key: "compress.summaryBuffer", expected: "boolean", actual: typeof compress.summaryBuffer })
        if (compress.protectTags !== undefined && typeof compress.protectTags !== "boolean")
            errors.push({ key: "compress.protectTags", expected: "boolean", actual: typeof compress.protectTags })
        if (compress.protectUserMessages !== undefined && typeof compress.protectUserMessages !== "boolean")
            errors.push({ key: "compress.protectUserMessages", expected: "boolean", actual: typeof compress.protectUserMessages })
    }

    return errors
}

test("getInvalidConfigKeys returns empty array for valid keys", () => {
    const result = getInvalidConfigKeys({ enabled: true, debug: false })
    assert.deepEqual(result, [])
})

test("getInvalidConfigKeys returns empty array for valid nested keys", () => {
    const result = getInvalidConfigKeys({
        enabled: true,
        turnProtection: { enabled: false, turns: 4 },
        compress: { mode: "range", nudgeForce: "soft" },
    })
    assert.deepEqual(result, [])
})

test("getInvalidConfigKeys returns dot-path keys for unknown nested keys", () => {
    const result = getInvalidConfigKeys({
        turnProtection: { enabled: false, unknownSubKey: true },
    })
    assert.ok(result.includes("turnProtection.unknownSubKey"))
})

test("getInvalidConfigKeys returns top-level unknown keys", () => {
    const result = getInvalidConfigKeys({ completelyUnknown: 123 })
    assert.deepEqual(result, ["completelyUnknown"])
})

test("getInvalidConfigKeys returns multiple unknown keys", () => {
    const result = getInvalidConfigKeys({ foo: 1, bar: 2, enabled: true })
    assert.ok(result.includes("foo"))
    assert.ok(result.includes("bar"))
    assert.ok(!result.includes("enabled"))
})

test("getInvalidConfigKeys does not recurse into modelMaxLimits dynamic keys", () => {
    const result = getInvalidConfigKeys({
        compress: { modelMaxLimits: { "provider/model-xyz": 50000 } },
    })
    assert.deepEqual(result, [])
})

test("validateConfigTypes returns empty array for valid config", () => {
    const result = validateConfigTypes({
        enabled: true,
        autoUpdate: false,
        debug: true,
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        protectedFilePatterns: ["*.env"],
    })
    assert.deepEqual(result, [])
})

test("validateConfigTypes catches wrong type for boolean field", () => {
    const result = validateConfigTypes({ enabled: "yes" })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "enabled")
    assert.equal(result[0].expected, "boolean")
    assert.equal(result[0].actual, "string")
})

test("validateConfigTypes catches invalid enum for pruneNotification", () => {
    const result = validateConfigTypes({ pruneNotification: "verbose" })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "pruneNotification")
    assert.ok(result[0].expected.includes("off"))
    assert.equal(result[0].actual, '"verbose"')
})

test("validateConfigTypes catches invalid enum for pruneNotificationType", () => {
    const result = validateConfigTypes({ pruneNotificationType: "email" })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "pruneNotificationType")
    assert.equal(result[0].actual, '"email"')
})

test("validateConfigTypes catches wrong type for protectedFilePatterns", () => {
    const result = validateConfigTypes({ protectedFilePatterns: "not-an-array" })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "protectedFilePatterns")
    assert.equal(result[0].expected, "string[]")
})

test("validateConfigTypes catches non-string entries in protectedFilePatterns", () => {
    const result = validateConfigTypes({ protectedFilePatterns: ["ok", 42] })
    assert.equal(result.length, 1)
    assert.equal(result[0].actual, "non-string entries")
})

test("validateConfigTypes catches wrong type in nested turnProtection", () => {
    const result = validateConfigTypes({
        turnProtection: { enabled: "yes", turns: 4 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "turnProtection.enabled")
})

test("validateConfigTypes catches negative turns in turnProtection", () => {
    const result = validateConfigTypes({
        turnProtection: { enabled: true, turns: 0 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "turnProtection.turns")
    assert.ok(result[0].expected.includes("positive"))
})

test("validateConfigTypes catches invalid compress.mode enum", () => {
    const result = validateConfigTypes({
        compress: { mode: "chunk" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.mode")
    assert.equal(result[0].actual, '"chunk"')
})

test("validateConfigTypes catches invalid compress.permission enum", () => {
    const result = validateConfigTypes({
        compress: { permission: "maybe" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.permission")
    assert.equal(result[0].actual, '"maybe"')
})

test("validateConfigTypes catches invalid compress.nudgeForce enum", () => {
    const result = validateConfigTypes({
        compress: { nudgeForce: "medium" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.nudgeForce")
    assert.equal(result[0].actual, '"medium"')
})

test("validateConfigTypes returns empty for undefined optional fields", () => {
    const result = validateConfigTypes({})
    assert.deepEqual(result, [])
})
