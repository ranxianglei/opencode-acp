import assert from "node:assert/strict"
import test from "node:test"
import { computeShouldNudge, resolveAdaptiveNudgeGrowth } from "../lib/messages/inject/utils"

const baseParams = {
    currentTokens: 20_000,
    modelContextLimit: 100_000,
    overMinLimit: false,
    overMaxLimit: false,
    lastNudgeTokens: 20_000 as number | undefined,
    minNudgeContextPercent: 15,
    nudgeGrowthTokens: 6000,
}

test("first observed turn (lastNudgeTokens === undefined) never nudges — baseline establishment", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 50_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: undefined,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, false)
    assert.equal(d.tipsVariant, null)
})

test("first turn does not nudge even at high context or over max", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 90_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: undefined,
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.equal(d.shouldNudge, false)
})

test("currentTokens undefined returns no-nudge", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: undefined,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, false)
    assert.equal(d.tipsVariant, null)
})

test("does not re-nudge before growth step reached", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 24_000,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, false)
})

test("re-nudges after growth step reached (no contextPct floor)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 26_500,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "normal")
})

test("nudge fires at very low contextPct once growth step is met (no 15% floor)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 1_000_000,
        lastNudgeTokens: 0,
        nudgeGrowthTokens: 6_000,
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

test("overMaxLimit nudges regardless of contextPct (legacy floor removed)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 10_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 10_000,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
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

test("minNudgeContextPercent param is ignored (legacy, kept for backward compat)", () => {
    const withFloor = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
        minNudgeContextPercent: 15,
    })
    const withoutFloor = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
        minNudgeContextPercent: 0,
    })
    assert.equal(withFloor.shouldNudge, withoutFloor.shouldNudge)
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

test("regression: post-compress lastNudgeTokens=currentTokens prevents immediate re-nudge", () => {
    const postCompressTokens = 250_000

    const immediate = computeShouldNudge({
        ...baseParams,
        currentTokens: postCompressTokens + 3_000,
        lastNudgeTokens: postCompressTokens,
        nudgeGrowthTokens: 50_000,
    })
    assert.equal(immediate.shouldNudge, false)

    const afterGrowth = computeShouldNudge({
        ...baseParams,
        currentTokens: postCompressTokens + 55_000,
        lastNudgeTokens: postCompressTokens,
        nudgeGrowthTokens: 50_000,
    })
    assert.equal(afterGrowth.shouldNudge, true)
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
