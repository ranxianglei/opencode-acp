import assert from "node:assert/strict"
import test from "node:test"
import { deepCloneConfig, mergeCompress, type CompressConfig } from "../lib/config"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config-validation"

const base: CompressConfig = {
    permission: "allow",
    showCompression: true,
    summaryBuffer: true,
    maxContextLimit: "55%",
    minContextLimit: "45%",
    nudgeFrequency: 5,
    minNudgeContextPercent: 15,
    nudgeForce: "soft",
    protectedTools: [],
    protectTags: false,
    protectUserMessages: false,
    maxSummaryLengthHard: 20000,
    minCompressRange: 2000,
    emergencyThresholdPercent: "98%",
}

// ── mergeCompress: nested providers deep-merge across config layers ──

test("providers: override layer wins when base has no providers", () => {
    const merged = mergeCompress(base, {
        providers: { anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } } } },
    })
    assert.deepEqual(merged.providers, {
        anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } } },
    })
})

test("providers: base layer preserved when override has no providers", () => {
    const baseWithProviders = {
        ...base,
        providers: { openai: { minNudgeContextPercent: 8 } },
    }
    const merged = mergeCompress(baseWithProviders, {})
    assert.deepEqual(merged.providers, { openai: { minNudgeContextPercent: 8 } })
})

test("providers: per-provider and per-model deep merge — project layer adds without wiping", () => {
    // Simulates the three-layer flow: global layer first, project layer second.
    const afterGlobal = mergeCompress(base, {
        providers: {
            anthropic: {
                minNudgeContextPercent: 8,
                models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
            },
        },
    })
    const afterProject = mergeCompress(afterGlobal, {
        providers: {
            openai: { minNudgeContextPercent: 6 }, // NEW provider — must not wipe anthropic
            anthropic: {
                minNudgeContextPercent: 9, // narrow the provider-level floor
                models: {
                    "claude-haiku-4-5": { minNudgeContextPercent: 4 }, // NEW model
                },
            },
        },
    })
    assert.deepEqual(afterProject.providers, {
        anthropic: {
            minNudgeContextPercent: 9,
            models: {
                "claude-sonnet-4-6": { minNudgeContextPercent: 10 }, // inherited
                "claude-haiku-4-5": { minNudgeContextPercent: 4 }, // added
            },
        },
        openai: { minNudgeContextPercent: 6 },
    })
})

test("providers: a higher layer cannot clear a provider/model it leaves unset", () => {
    const baseWithProviders = {
        ...base,
        providers: {
            anthropic: {
                minNudgeContextPercent: 8,
                models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
            },
        },
    }
    const merged = mergeCompress(baseWithProviders, {
        providers: { anthropic: { models: {} } },
    })
    // models: {} carries no explicit model → base models survive; the provider
    // level was not set in the override either → 8 survives.
    assert.deepEqual(merged.providers, {
        anthropic: {
            minNudgeContextPercent: 8,
            models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
        },
    })
})

test("providers: deepCloneConfig isolates the nested maps", () => {
    const config = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            ...base,
            providers: {
                anthropic: {
                    minNudgeContextPercent: 8,
                    models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
                },
            },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: {
            enabled: false,
            filters: {},
        },
    } as any
    const clone = deepCloneConfig(config)
    // Mutate every nested level of the clone.
    clone.compress.providers!.anthropic.minNudgeContextPercent = 99
    clone.compress.providers!.anthropic.models!["claude-sonnet-4-6"]!.minNudgeContextPercent = 99
    clone.compress.providers!.openai = { minNudgeContextPercent: 99 }
    // The original is untouched.
    assert.equal(config.compress.providers.anthropic.minNudgeContextPercent, 8)
    assert.equal(config.compress.providers.anthropic.models["claude-sonnet-4-6"].minNudgeContextPercent, 10)
    assert.equal(config.compress.providers.openai, undefined)
})

// ── validation: structure + typo safety ──

test("providers: valid nested config passes validation and key walking", () => {
    const userConfig = {
        compress: {
            providers: {
                anthropic: {
                    minNudgeContextPercent: 8,
                    models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
                },
            },
        },
    }
    assert.deepEqual(getInvalidConfigKeys(userConfig), [])
    const errors = validateConfigTypes(userConfig)
    assert.deepEqual(errors, [])
})

test("providers: rejects non-object providers / provider / models entries", () => {
    assert.deepEqual(validateConfigTypes({ compress: { providers: "nope" } }).map((e) => e.key), [
        "compress.providers",
    ])
    assert.deepEqual(
        validateConfigTypes({ compress: { providers: { anthropic: 5 } } }).map((e) => e.key),
        ["compress.providers.anthropic"]
    )
    assert.deepEqual(
        validateConfigTypes({ compress: { providers: { anthropic: { models: 5 } } } }).map((e) => e.key),
        ["compress.providers.anthropic.models"]
    )
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { models: { "claude-x": 5 } } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.models.claude-x"]
    )
})

test("providers: rejects out-of-range / non-number percent values", () => {
    const keys = (providers: unknown) =>
        validateConfigTypes({ compress: { providers } }).map((e) => e.key)
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: -1 } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: 101 } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: "30%" } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 150 } } } }), [
        "compress.providers.anthropic.models.m.minNudgeContextPercent",
    ])
    // Boundary values are valid: 0 disables the floor, 100 clamps at the window.
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 0 } } } }), [])
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 100 } } } }), [])
})

test("providers: unknown fields are rejected (typo safety)", () => {
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { minNudgeContextPecent: 10 } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.minNudgeContextPecent"]
    )
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { models: { m: { floor: 10 } } } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.models.m.floor"]
    )
})
