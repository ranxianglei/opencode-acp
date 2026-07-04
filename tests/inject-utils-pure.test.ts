import assert from "node:assert/strict"
import test from "node:test"
import { computeShouldNudge, resolveAdaptiveNudgeGrowth } from "../lib/messages/inject/utils"

const baseParams = {
    currentTokens: 0,
    modelContextLimit: 100_000,
    overMinLimit: false,
    overMaxLimit: false,
    lastNudgeTokens: 0,
    minNudgeContextPercent: 15,
    nudgeGrowthTokens: 6000,
}

test("no nudge when contextPct below floor (even on first nudge)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 5000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
    })
    assert.equal(d.shouldNudge, false)
    assert.equal(d.tipsVariant, null)
})

test("first nudge ever fires once floor is met (lastNudgeTokens === 0)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 20_000,
        lastNudgeTokens: 0,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "normal")
})

test("does not re-nudge before growth step reached", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 24_000,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, false)
})

test("re-nudges after growth step reached", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 26_500,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "normal")
})

test("overMaxLimit bypasses frequency gating", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 26_000,
        lastNudgeTokens: 25_000,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
})

test("overMaxLimit still requires context floor (small models)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 10_000,
        lastNudgeTokens: 0,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, false)
})

test("overMinLimit produces minLimit variant", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 30_000,
        lastNudgeTokens: 0,
        overMinLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "minLimit")
})

test("overMaxLimit takes precedence over overMinLimit", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 90_000,
        lastNudgeTokens: 0,
        overMinLimit: true,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
})

test("no modelContextLimit disables context floor (never nudges)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 500_000,
        modelContextLimit: undefined,
        lastNudgeTokens: 0,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, false)
})

test("custom minNudgeContextPercent respected", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 10_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
        minNudgeContextPercent: 5,
    })
    assert.equal(d.shouldNudge, true)
})

test("custom nudgeGrowthTokens respected", () => {
    const tight = computeShouldNudge({
        ...baseParams,
        currentTokens: 22_000,
        lastNudgeTokens: 20_000,
        nudgeGrowthTokens: 1000,
    })
    assert.equal(tight.shouldNudge, true)

    const loose = computeShouldNudge({
        ...baseParams,
        currentTokens: 22_000,
        lastNudgeTokens: 20_000,
        nudgeGrowthTokens: 5000,
    })
    assert.equal(loose.shouldNudge, false)
})

test("resolveAdaptiveNudgeGrowth: undefined limit returns floor", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(undefined), 6000)
})

test("resolveAdaptiveNudgeGrowth: zero/negative limit returns floor", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(0), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(-100), 6000)
})

test("resolveAdaptiveNudgeGrowth: tiny context floored at 6K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(10_000), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(50_000), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(100_000), 6000)
})

test("resolveAdaptiveNudgeGrowth: 128K mainstream model", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(128_000), 6400)
})

test("resolveAdaptiveNudgeGrowth: 200K → 10K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(200_000), 10_000)
})

test("resolveAdaptiveNudgeGrowth: 1M → 50K (5% exact)", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(1_000_000), 50_000)
})

test("resolveAdaptiveNudgeGrowth: multi-million capped at 50K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(2_000_000), 50_000)
    assert.equal(resolveAdaptiveNudgeGrowth(10_000_000), 50_000)
})
