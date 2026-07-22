import assert from "node:assert/strict"
import test from "node:test"
import { mergeCompress, type CompressConfig } from "../lib/config"

const base: CompressConfig = {
    mode: "range",
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
}

test("explicit compress protected tools replace the inherited policy", () => {
    assert.deepEqual(mergeCompress(base, {}).protectedTools, ["skill"])
    assert.deepEqual(mergeCompress(base, { protectedTools: ["task"] }).protectedTools, ["task"])
    assert.deepEqual(mergeCompress(base, { protectedTools: [] }).protectedTools, [])
})

// Chaining mergeCompress calls mirrors how mergeLayer chains them inside
// getConfig() across the global → configDir → project layers.
test("replacement survives across multiple config merge layers", () => {
    const afterGlobal = mergeCompress(base, { protectedTools: ["my_tool"] })
    assert.deepEqual(afterGlobal.protectedTools, ["my_tool"])

    const afterConfigDir = mergeCompress(afterGlobal, {})
    assert.deepEqual(afterConfigDir.protectedTools, ["my_tool"])

    const afterProject = mergeCompress(afterConfigDir, { protectedTools: [] })
    assert.deepEqual(afterProject.protectedTools, [])

    const emptyGlobal = mergeCompress(base, { protectedTools: [] })
    assert.deepEqual(emptyGlobal.protectedTools, [])
    const taskProject = mergeCompress(emptyGlobal, { protectedTools: ["task"] })
    assert.deepEqual(taskProject.protectedTools, ["task"])
})
