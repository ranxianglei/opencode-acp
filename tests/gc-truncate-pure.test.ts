import assert from "node:assert/strict"
import test from "node:test"
import { shouldRunMajorGC, getGCParams } from "../lib/gc/truncate"
import type { GCConfig } from "../lib/config"

function makeGCConfig(overrides: Partial<GCConfig> = {}): GCConfig {
    return {
        algorithm: "truncate",
        promotionThreshold: 5,
        maxBlockAge: 15,
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        ...overrides,
    }
}

test("shouldRunMajorGC returns true when tokens >= threshold percentage", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: "80%" })
    assert.equal(shouldRunMajorGC(90000, 100000, gc), true)
})

test("shouldRunMajorGC returns false when tokens < threshold", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: "80%" })
    assert.equal(shouldRunMajorGC(70000, 100000, gc), false)
})

test("shouldRunMajorGC returns true at exact threshold boundary", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: "80%" })
    assert.equal(shouldRunMajorGC(80000, 100000, gc), true)
})

test("shouldRunMajorGC returns false when modelContextLimit is undefined", () => {
    const gc = makeGCConfig()
    assert.equal(shouldRunMajorGC(999999, undefined, gc), false)
})

test("shouldRunMajorGC returns false when modelContextLimit is 0", () => {
    const gc = makeGCConfig()
    assert.equal(shouldRunMajorGC(999999, 0, gc), false)
})

test("shouldRunMajorGC handles absolute number threshold", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: 50000 })
    assert.equal(shouldRunMajorGC(60000, 200000, gc), true)
    assert.equal(shouldRunMajorGC(40000, 200000, gc), false)
})

test("shouldRunMajorGC with 100% threshold triggers at full context", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: "100%" })
    assert.equal(shouldRunMajorGC(100000, 100000, gc), true)
    assert.equal(shouldRunMajorGC(99999, 100000, gc), false)
})

test("shouldRunMajorGC with 50% threshold", () => {
    const gc = makeGCConfig({ majorGcThresholdPercent: "50%" })
    assert.equal(shouldRunMajorGC(100000, 200000, gc), true)
    assert.equal(shouldRunMajorGC(99999, 200000, gc), false)
})

test("getGCParams returns correct params from config", () => {
    const gc = makeGCConfig({ maxOldGenSummaryLength: 5000 })
    const params = getGCParams(gc, 200000, 150000)
    assert.equal(params.maxOldGenSummaryLength, 5000)
    assert.equal(params.modelContextLimit, 200000)
    assert.equal(params.currentTokens, 150000)
})

test("getGCParams returns defaults from config", () => {
    const gc = makeGCConfig()
    const params = getGCParams(gc, 100000, 50000)
    assert.equal(params.maxOldGenSummaryLength, 3000)
    assert.equal(params.modelContextLimit, 100000)
    assert.equal(params.currentTokens, 50000)
})
