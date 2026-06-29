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

test("validateConfigTypes rejects compress.maxSummaryLengthHard < maxSummaryLength", () => {
    const result = validateConfigTypes({
        compress: { maxSummaryLength: 200, maxSummaryLengthHard: 100 },
    })
    const hit = result.find((e) => e.key === "compress.maxSummaryLengthHard")
    assert.ok(hit, "hard ceiling below soft target must be flagged")
    assert.ok(hit!.expected.includes(">= maxSummaryLength"))
})
