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

const OPTS = {}

test("single range: returned with dangerous flag", () => {
    const ranges = [makeRange("m00001", "m00003", 3, 80_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 1)
    assert.equal(result[0].dangerous, true)
})

test("small single range not suppressed (Issue #251 regression)", () => {
    const ranges = [makeRange("m00001", "m00001", 1, 10_000)]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 1, "small ranges must not be suppressed")
    assert.equal(result[0].dangerous, true)
})

test("multiple ranges: all shown, only last gets dangerous", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 30_000),
        makeRange("m00010", "m00015", 6, 20_000),
        makeRange("m00020", "m00025", 6, 15_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 3)
    assert.equal(result[0].dangerous, undefined)
    assert.equal(result[1].dangerous, undefined)
    assert.equal(result[2].dangerous, true)
})

test("aggregate below old 5% threshold no longer suppresses (Issue #251)", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 15_000),
        makeRange("m00006", "m00008", 3, 10_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 2, "25K total at 1M context must not be suppressed")
    assert.equal(result[0].dangerous, undefined)
    assert.equal(result[1].dangerous, true)
})

test("tiny ranges (500 tokens) still shown — minCompressRange is the backstop", () => {
    const ranges = [
        makeRange("m00001", "m00002", 2, 300),
        makeRange("m00003", "m00004", 2, 200),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 2)
})

test("empty input returns empty", () => {
    const result = filterRecommendedRanges([], [], OPTS)
    assert.equal(result.length, 0)
})

test("protected ranges do not affect filtering logic", () => {
    const ranges = [
        makeRange("m00001", "m00005", 5, 60_000),
        makeRange("m00006", "m00010", 5, 50_000),
    ]
    const protectedRanges = [makeProtected("m00020", "m00030", 11, 300_000)]
    const withoutProtected = filterRecommendedRanges(ranges, [], OPTS)
    const withProtected = filterRecommendedRanges(ranges, protectedRanges, OPTS)
    assert.deepEqual(withProtected, withoutProtected)
})
