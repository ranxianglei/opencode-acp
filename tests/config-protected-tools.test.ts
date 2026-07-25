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
