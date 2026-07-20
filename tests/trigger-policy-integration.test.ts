import assert from "node:assert/strict"
import test from "node:test"

import {
    ensureBuiltinTriggerPolicyRegistered,
    getDefaultTriggerPolicy,
    listTriggerPolicies,
    clearTriggerPolicyRegistryForTests,
} from "../lib/messages/inject/policy"

test("ensureBuiltinTriggerPolicyRegistered auto-registers context-compress-algorithms-trigger from context-compress-algorithms", () => {
    clearTriggerPolicyRegistryForTests()
    ensureBuiltinTriggerPolicyRegistered()
    const registered = listTriggerPolicies()
    assert.ok(
        registered.includes("context-compress-algorithms-trigger"),
        "context-compress-algorithms-trigger should be auto-registered from context-compress-algorithms package",
    )

    ensureBuiltinTriggerPolicyRegistered()
    const stillOnce = listTriggerPolicies().filter((n) => n === "context-compress-algorithms-trigger").length
    assert.equal(stillOnce, 1, "double-init should not duplicate registration")
})

test("default trigger policy returns growth-only cadence decisions", () => {
    clearTriggerPolicyRegistryForTests()
    ensureBuiltinTriggerPolicyRegistered()
    const policy = getDefaultTriggerPolicy()
    assert.ok(policy, "policy must be registered")
    assert.equal(policy!.name, "context-compress-algorithms-trigger")

    const firstTurn = policy!.computeShouldNudge({
        currentTokens: 10000,
        modelContextLimit: 200000,
        overMinLimit: false,
        overMaxLimit: false,
        lastNudgeTokens: undefined,
        minNudgeContextPercent: 15,
        nudgeGrowthTokens: 6000,
    })
    assert.equal(firstTurn.shouldNudge, false, "first observed turn establishes baseline")

    const smallGrowth = policy!.computeShouldNudge({
        currentTokens: 12000,
        modelContextLimit: 200000,
        overMinLimit: false,
        overMaxLimit: false,
        lastNudgeTokens: 10000,
        minNudgeContextPercent: 15,
        nudgeGrowthTokens: 6000,
    })
    assert.equal(smallGrowth.shouldNudge, false, "growth below threshold does not nudge")

    const bigGrowth = policy!.computeShouldNudge({
        currentTokens: 20000,
        modelContextLimit: 200000,
        overMinLimit: true,
        overMaxLimit: false,
        lastNudgeTokens: 10000,
        minNudgeContextPercent: 15,
        nudgeGrowthTokens: 6000,
    })
    assert.equal(bigGrowth.shouldNudge, true, "growth above threshold nudges")
    assert.equal(bigGrowth.tipsVariant, "minLimit", "overMinLimit sets minLimit variant")

    const overMax = policy!.computeShouldNudge({
        currentTokens: 195000,
        modelContextLimit: 200000,
        overMinLimit: true,
        overMaxLimit: true,
        lastNudgeTokens: 10000,
        minNudgeContextPercent: 15,
        nudgeGrowthTokens: 6000,
    })
    assert.equal(overMax.shouldNudge, true, "overMaxLimit forces nudge")
    assert.equal(overMax.tipsVariant, "maxLimit", "overMaxLimit sets maxLimit variant")
})

test("default trigger policy resolves adaptive growth thresholds", () => {
    clearTriggerPolicyRegistryForTests()
    ensureBuiltinTriggerPolicyRegistered()
    const policy = getDefaultTriggerPolicy()!

    assert.equal(policy.resolveAdaptiveNudgeGrowth(undefined), 6000, "floor when no limit")
    assert.equal(policy.resolveAdaptiveNudgeGrowth(0), 6000, "floor when zero limit")
    assert.equal(policy.resolveAdaptiveNudgeGrowth(-100), 6000, "floor when negative limit")
    assert.equal(policy.resolveAdaptiveNudgeGrowth(100000), 6000, "5% of 100K = 5000, but floor (6000) wins")
    assert.equal(policy.resolveAdaptiveNudgeGrowth(200000), 10000, "5% of 200K = 10000")
    assert.equal(policy.resolveAdaptiveNudgeGrowth(2000000), 50000, "capped at 50000")
})
