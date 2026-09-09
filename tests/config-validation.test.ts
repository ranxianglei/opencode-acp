import assert from "node:assert/strict"
import test from "node:test"
import { getInvalidConfigKeys, validateConfigTypes, VALID_CONFIG_KEYS } from "../lib/config-validation"

test("getInvalidConfigKeys returns empty array for valid keys", () => {
    const result = getInvalidConfigKeys({ enabled: true, debug: false })
    assert.deepEqual(result, [])
})

test("getInvalidConfigKeys returns empty array for valid nested keys", () => {
    const result = getInvalidConfigKeys({
        enabled: true,
        compress: { nudgeForce: "soft" },
    })
    assert.deepEqual(result, [])
})

test("getInvalidConfigKeys accepts compress.toolOutputNudgeThreshold (#18)", () => {
    const result = getInvalidConfigKeys({
        compress: { toolOutputNudgeThreshold: 20000 },
    })
    assert.deepEqual(result, [])
})

test("getInvalidConfigKeys returns dot-path keys for unknown nested keys", () => {
    const result = getInvalidConfigKeys({
        compress: { nudgeForce: "soft", unknownSubKey: true },
    })
    assert.ok(result.includes("compress.unknownSubKey"))
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

test("getInvalidConfigKeys does not recurse into messageFilters.filters dynamic keys", () => {
    const result = getInvalidConfigKeys({
        messageFilters: { filters: { "omo-mode-injection": { enabled: true } } },
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

test("validateConfigTypes accepts numeric compress.maxSummaryLengthHard", () => {
    const result = validateConfigTypes({
        compress: { maxSummaryLengthHard: 800 },
    })
    assert.deepEqual(result, [])
})

test("validateConfigTypes catches wrong type for compress.maxSummaryLengthHard", () => {
    const result = validateConfigTypes({
        compress: { maxSummaryLengthHard: "800" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.maxSummaryLengthHard")
    assert.equal(result[0].actual, "string")
})

test("validateConfigTypes accepts numeric compress.emergencyThresholdPercent", () => {
    const result = validateConfigTypes({
        compress: { emergencyThresholdPercent: 980000 },
    })
    assert.deepEqual(result, [])
})

test("validateConfigTypes accepts percentage string compress.emergencyThresholdPercent", () => {
    const result = validateConfigTypes({
        compress: { emergencyThresholdPercent: "95%" },
    })
    assert.deepEqual(result, [])
})

test("validateConfigTypes rejects negative numeric compress.emergencyThresholdPercent", () => {
    const result = validateConfigTypes({
        compress: { emergencyThresholdPercent: -1 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.emergencyThresholdPercent")
})

test("validateConfigTypes rejects malformed percentage string in emergencyThresholdPercent", () => {
    const result = validateConfigTypes({
        compress: { emergencyThresholdPercent: "abc%" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.emergencyThresholdPercent")
})

test("validateConfigTypes rejects percentage > 100 in emergencyThresholdPercent", () => {
    const result = validateConfigTypes({
        compress: { emergencyThresholdPercent: "150%" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.emergencyThresholdPercent")
})

test("validateConfigTypes catches wrong type for compress.lastSegmentSoftBlock", () => {
    const result = validateConfigTypes({
        compress: { lastSegmentSoftBlock: "yes" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.lastSegmentSoftBlock")
    assert.equal(result[0].expected, "boolean")
})

test("validateConfigTypes catches wrong type for compress.preserveRecentMessages", () => {
    const result = validateConfigTypes({
        compress: { preserveRecentMessages: "20" },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.preserveRecentMessages")
    assert.equal(result[0].expected, "number")
})

test("validateConfigTypes rejects negative compress.preserveRecentMessages", () => {
    const result = validateConfigTypes({
        compress: { preserveRecentMessages: -5 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.preserveRecentMessages")
})

test("validateConfigTypes catches wrong type for compress.preserveRecentTokens", () => {
    const result = validateConfigTypes({
        compress: { preserveRecentTokens: true },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.preserveRecentTokens")
    assert.equal(result[0].expected, "number")
})

test("validateConfigTypes rejects negative compress.preserveRecentTokens", () => {
    const result = validateConfigTypes({
        compress: { preserveRecentTokens: -100 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.preserveRecentTokens")
})

test("validateConfigTypes catches wrong type for compress.preserveLastUserMessage", () => {
    const result = validateConfigTypes({
        compress: { preserveLastUserMessage: 1 },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.preserveLastUserMessage")
    assert.equal(result[0].expected, "boolean")
})

test("getInvalidConfigKeys accepts new preserveRecent* keys", () => {
    const result = getInvalidConfigKeys({
        compress: {
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
        },
    })
    assert.equal(result.length, 0)
})

// ── compress.reasoning (#368): nested object validation ──

test("getInvalidConfigKeys accepts compress.reasoning with valid drop/threshold", () => {
    const result = getInvalidConfigKeys({
        compress: {
            reasoning: { drop: true, threshold: 2048 },
        },
    })
    assert.equal(result.length, 0)
})

test("validateConfigTypes accepts partial compress.reasoning objects", () => {
    assert.equal(
        validateConfigTypes({ compress: { reasoning: { drop: false } } }).length,
        0,
    )
    assert.equal(
        validateConfigTypes({ compress: { reasoning: { threshold: 0 } } }).length,
        0,
    )
    assert.equal(
        validateConfigTypes({ compress: { reasoning: {} } }).length,
        0,
    )
})

test("validateConfigTypes rejects non-object compress.reasoning", () => {
    const result = validateConfigTypes({ compress: { reasoning: true } })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.reasoning")
})

test("validateConfigTypes catches wrong type for compress.reasoning.drop", () => {
    const result = validateConfigTypes({ compress: { reasoning: { drop: "yes" } } })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.reasoning.drop")
    assert.equal(result[0].expected, "boolean")
})

test("validateConfigTypes rejects non-integer and negative compress.reasoning.threshold", () => {
    const floaty = validateConfigTypes({ compress: { reasoning: { threshold: 12.5 } } })
    assert.equal(floaty.length, 1)
    assert.equal(floaty[0].key, "compress.reasoning.threshold")

    const negative = validateConfigTypes({ compress: { reasoning: { threshold: -1 } } })
    assert.equal(negative.length, 1)
    assert.equal(negative[0].key, "compress.reasoning.threshold")

    const stringy = validateConfigTypes({ compress: { reasoning: { threshold: "2048" } } })
    assert.equal(stringy.length, 1)
    assert.equal(stringy[0].key, "compress.reasoning.threshold")
})

test("validateConfigTypes treats null compress.reasoning as invalid, not a crash", () => {
    // Regression: typeof null === "object" previously let null slip past the
    // object check and crash on `.drop` instead of producing an error entry.
    const result = validateConfigTypes({ compress: { reasoning: null } })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.reasoning")
})

test("validateConfigTypes accepts reasoning overrides inside compress.providers", () => {
    // Regression: reasoning was missing from OVERRIDE_FIELD_TYPES, so the
    // documented cascade config produced a spurious "unknown field" warning.
    const providerLevel = validateConfigTypes({
        compress: {
            providers: {
                "my-gateway": { reasoning: { drop: false } },
                anthropic: {
                    reasoning: { threshold: 8000 },
                    models: { "claude-opus-4-5": { reasoning: { threshold: 16000 } } },
                },
            },
        },
    })
    assert.equal(providerLevel.length, 0)
})

test("validateConfigTypes rejects invalid reasoning overrides inside compress.providers", () => {
    const result = validateConfigTypes({
        compress: {
            providers: {
                "my-gateway": {
                    reasoning: { drop: "no", threshold: -3 },
                    models: { "bad-model": { reasoning: { threshold: 1.5 } } },
                },
            },
        },
    })
    assert.equal(result.length, 3)
    assert.deepEqual(
        result.map((e) => e.key).sort(),
        [
            "compress.providers.my-gateway.models.bad-model.reasoning.threshold",
            "compress.providers.my-gateway.reasoning.drop",
            "compress.providers.my-gateway.reasoning.threshold",
        ],
    )
})

test("validateConfigTypes rejects non-object reasoning overrides inside compress.providers", () => {
    const result = validateConfigTypes({
        compress: { providers: { "my-gateway": { reasoning: true } } },
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].key, "compress.providers.my-gateway.reasoning")
})

test("getInvalidConfigKeys flags unknown fields nested inside compress.reasoning", () => {
    // Typo safety: key-path walking recurses into the nested reasoning object.
    const result = getInvalidConfigKeys({
        compress: { reasoning: { dropp: true, threshold: 2048 } },
    })
    assert.deepEqual(result, ["compress.reasoning.dropp"])
})
