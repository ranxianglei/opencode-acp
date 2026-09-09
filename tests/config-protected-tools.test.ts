import assert from "node:assert/strict"
import test from "node:test"
import { mergeCompress, type CompressConfig } from "../lib/config"

const base: CompressConfig = {
    permission: "allow",
    showCompression: true,
    summaryBuffer: true,
    maxContextLimit: "55%",
    minContextLimit: "45%",
    nudgeFrequency: 5,
    minNudgeContextPercent: 15,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: ["skill"],
    protectTags: false,
    protectUserMessages: false,
    maxSummaryLengthHard: 20000,
    minCompressRange: 5000,
    minNudgeGrowthRatio: 0.45,
    minNudgeGrowthFloor: 5000,
    emergencyThresholdPercent: "98%",
    maxVisibleSegments: 50,
    keepEmbedMaxChars: 2000,
    reasoning: { drop: true, threshold: 2048 },
}

test("no override returns base protectedTools unchanged", () => {
    assert.deepEqual(mergeCompress(base, {}).protectedTools, ["skill"])
})

test("explicit override replaces inherited policy but 'compress' is force-appended", () => {
    assert.deepEqual(mergeCompress(base, { protectedTools: ["task"] }).protectedTools, ["task", "compress"])
})

test("empty array override still force-protects 'compress'", () => {
    assert.deepEqual(mergeCompress(base, { protectedTools: [] }).protectedTools, ["compress"])
})

test("override that already includes 'compress' does not duplicate", () => {
    assert.deepEqual(mergeCompress(base, { protectedTools: ["skill", "compress"] }).protectedTools, ["skill", "compress"])
})

test("force-protection survives across multiple config merge layers", () => {
    const afterGlobal = mergeCompress(base, { protectedTools: ["my_tool"] })
    assert.deepEqual(afterGlobal.protectedTools, ["my_tool", "compress"])

    const afterConfigDir = mergeCompress(afterGlobal, {})
    assert.deepEqual(afterConfigDir.protectedTools, ["my_tool", "compress"])

    const afterProject = mergeCompress(afterConfigDir, { protectedTools: [] })
    assert.deepEqual(afterProject.protectedTools, ["compress"])

    const emptyGlobal = mergeCompress(base, { protectedTools: [] })
    assert.deepEqual(emptyGlobal.protectedTools, ["compress"])
    const taskProject = mergeCompress(emptyGlobal, { protectedTools: ["task"] })
    assert.deepEqual(taskProject.protectedTools, ["task", "compress"])
})

test("reasoning merges field-wise across layers and defaults when unset", () => {
    // No reasoning in either layer -> defaults
    const defaults = mergeCompress(base, {})
    assert.deepEqual(defaults.reasoning, { drop: true, threshold: 2048 })

    // Override layer sets only drop -> threshold inherits from base
    const partial = mergeCompress(base, { reasoning: { drop: false } })
    assert.deepEqual(partial.reasoning, { drop: false, threshold: 2048 })

    // Override layer sets only threshold -> drop inherits from base
    const thresholdOnly = mergeCompress(base, { reasoning: { threshold: 0 } })
    assert.deepEqual(thresholdOnly.reasoning, { drop: true, threshold: 0 })

    // Both layers present -> override wins per field
    const stacked = mergeCompress(partial, { reasoning: { threshold: 8000 } })
    assert.deepEqual(stacked.reasoning, { drop: false, threshold: 8000 })

    // Base without reasoning (legacy fixture) falls back to defaults
    const legacy = { ...base, reasoning: undefined } as unknown as CompressConfig
    const legacyMerged = mergeCompress(legacy, {})
    assert.deepEqual(legacyMerged.reasoning, { drop: true, threshold: 2048 })
})
