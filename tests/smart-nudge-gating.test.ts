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

test("last segment < 2x growth threshold (10% for 1M) excluded + suppressed", () => {
    const ranges = [makeRange("m00001", "m00003", 3, 80_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0, "80K < 100K floor → excluded, effective=0 < 50K gate")
})

test("last segment far above threshold: 300K, effective = 200K shown with dangerous", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 300_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
    assert.equal(result[0].dangerous, true)
})

test("single range at exactly 3x (150K): floor passes + gate passes", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 150_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
    assert.equal(result[0].dangerous, true)
})

test("single range at 2x boundary (100K): floor passes but gate fails (effective=0)", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 100_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0, "effective = max(0, 100K-100K) = 0 < 50K gate")
})

test("non-last range never gets dangerous flag, last range does", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 60_000),
        makeRange("m00010", "m00015", 6, 150_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 2)
    assert.equal(result[0].dangerous, undefined)
    assert.equal(result[1].dangerous, true)
})

test("gate: single non-last range below growth threshold suppressed", () => {
    const ranges = [makeRange("m00001", "m00005", 5, 30_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("effective compressible: non-last 40K + last 80K (excluded) = 40K < 50K suppressed", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 40_000),
        makeRange("m00006", "m00008", 3, 80_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("effective compressible: non-last 60K + last 80K (excluded) = 60K >= 50K shown", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 60_000),
        makeRange("m00006", "m00008", 3, 80_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 1)
    assert.equal(result[0].startRef, "m00001")
    assert.equal(result[0].dangerous, undefined)
})

test("effective compressible: non-last 40K + last 150K = 40K + 50K = 90K >= 50K shown", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 40_000),
        makeRange("m00006", "m00010", 5, 150_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 2)
    assert.equal(result[0].dangerous, undefined)
    assert.equal(result[1].dangerous, true)
})

test("protected ranges do not affect filtering logic", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 60_000),
        makeRange("m00006", "m00010", 5, 150_000),
    ]
    const protectedRanges = [makeProtected("m00020", "m00030", 11, 300_000)]
    const withoutProtected = filterRecommendedRanges(ranges, [], OPTS_1M)
    const withProtected = filterRecommendedRanges(ranges, protectedRanges, OPTS_1M)
    assert.deepEqual(withProtected, withoutProtected)
})

test("single small message as only range suppressed", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 10_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("empty input returns empty", () => {
    const result = filterRecommendedRanges([], [], OPTS_1M)
    assert.equal(result.length, 0)
})

test("modelContextLimit unknown: returns all with last marked dangerous", () => {
    const ranges = [
        makeRange("m00001", "m00001", 1, 100),
        makeRange("m00002", "m00005", 4, 200),
    ]
    const result = filterRecommendedRanges(ranges, [], {
        modelContextLimit: undefined,
        growthRatio: 0.05,
    })
    assert.equal(result.length, 2)
    assert.equal(result[0].dangerous, undefined)
    assert.equal(result[1].dangerous, true)
})

test("200K context: growth=10K, floor=20K. 35K → effective=15K >= 10K shown", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 35_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_200K)
    assert.equal(result.length, 1)
    assert.equal(result[0].dangerous, true)
})

test("200K context: 25K → effective=5K < 10K suppressed", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 25_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS_200K)
    assert.equal(result.length, 0)
})
