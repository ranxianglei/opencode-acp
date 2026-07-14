import assert from "node:assert/strict"
import test from "node:test"
import { filterRecommendedRanges } from "../lib/messages/inject/utils"
import type { CompressibleRange, ProtectedRange } from "../lib/messages/inject/utils"

function makeRange(
    startRef: string,
    endRef: string,
    count: number,
    tokens: number,
    toolPct = 100,
): CompressibleRange {
    return { startRef, endRef, count, tokens, toolPct, textPct: 100 - toolPct }
}

function makeProtected(
    startRef: string,
    endRef: string,
    count: number,
    tokens: number,
    tools: string[] = ["skill"],
): ProtectedRange {
    return { startRef, endRef, count, tokens, tools }
}

const OPTS_1M = { modelContextLimit: 1_000_000, growthRatio: 0.05 }
const OPTS_200K = { modelContextLimit: 200_000, growthRatio: 0.05 }

test("filterRecommendedRanges: single-message range filtered when below huge threshold", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 100_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("filterRecommendedRanges: single-message range kept when above huge threshold (250K for 1M)", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 300_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
    assert.equal(result[0].startRef, "m00001")
})

test("filterRecommendedRanges: multi-message range kept when tokens exceed 5%", () => {
    const ranges = [makeRange("m00001", "m00003", 3, 60_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
})

test("filterRecommendedRanges: mixed single and multi-message ranges", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 80_000),
        makeRange("m00006", "m00006", 1, 10_000),
        makeRange("m00007", "m00007", 1, 300_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 2)
    assert.equal(result[0].startRef, "m00001")
    assert.equal(result[1].startRef, "m00007")
})

test("filterRecommendedRanges: suppresses all when compressible too small (< 5%)", () => {
    const ranges = [makeRange("m00001", "m00005", 5, 30_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("filterRecommendedRanges: shows ranges when compressible >= 5%", () => {
    const ranges = [makeRange("m00001", "m00005", 5, 60_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
})

test("filterRecommendedRanges: suppresses when only last range compressible + protected exist", () => {
    const ranges = [makeRange("m00010", "m00012", 3, 60_000)]
    const protectedRanges = [makeProtected("m00001", "m00009", 9, 200_000)]
    const result = filterRecommendedRanges(ranges, protectedRanges, OPTS_1M)
    assert.equal(result.length, 0)
})

test("filterRecommendedRanges: shows when multiple compressible ranges exist alongside protected", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 60_000),
        makeRange("m00010", "m00015", 6, 80_000),
    ]
    const protectedRanges = [makeProtected("m00006", "m00009", 4, 200_000)]
    const result = filterRecommendedRanges(ranges, protectedRanges, OPTS_1M)
    assert.equal(result.length, 2)
})

test("filterRecommendedRanges: suppresses when 70%+ protected", () => {
    const ranges = [makeRange("m00001", "m00005", 5, 60_000)]
    const protectedRanges = [makeProtected("m00006", "m00020", 15, 200_000)]
    const total = 60_000 + 200_000
    assert.ok(200_000 / total >= 0.7, "verify test data is 70%+ protected")
    const result = filterRecommendedRanges(ranges, protectedRanges, OPTS_1M)
    assert.equal(result.length, 0)
})

test("filterRecommendedRanges: huge single range overrides protected dominance", () => {
    const ranges = [makeRange("m00010", "m00010", 1, 300_000)]
    const protectedRanges = [makeProtected("m00001", "m00009", 9, 200_000)]
    const result = filterRecommendedRanges(ranges, protectedRanges, OPTS_1M)
    assert.equal(result.length, 1)
    assert.equal(result[0].startRef, "m00010")
})

test("filterRecommendedRanges: returns all when modelContextLimit unknown", () => {
    const ranges = [
        makeRange("m00001", "m00001", 1, 100),
        makeRange("m00002", "m00005", 4, 200),
    ]
    const result = filterRecommendedRanges(ranges, [], {
        modelContextLimit: undefined,
        growthRatio: 0.05,
    })
    assert.equal(result.length, 2)
})

test("filterRecommendedRanges: 200K context uses proportionally smaller thresholds", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 60_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_200K)
    assert.equal(result.length, 1, "60K > 50K (5x of 10K growthThreshold for 200K context)")
})

test("filterRecommendedRanges: suppresses when only compressible range and no protected (single small range)", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 10_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0, "single small range filtered by req 2")
})

test("filterRecommendedRanges: empty input returns empty", () => {
    const result = filterRecommendedRanges([], [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("filterRecommendedRanges: multi-message range suppressed when total compressible < 5%", () => {
    const ranges = [makeRange("m00001", "m00003", 3, 500)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0, "tiny multi-message range still filtered by list-level check")
})
