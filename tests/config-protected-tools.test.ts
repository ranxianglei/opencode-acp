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
