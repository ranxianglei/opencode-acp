import assert from "node:assert/strict"
import test from "node:test"
import {
    filterRecommendedRanges,
    EFFECTIVE_MIN_COMPRESSIBLE_TOKENS,
} from "../lib/messages/inject/utils"
import type { CompressibleRange, ProtectedRange } from "../lib/messages/inject/utils"

function makeRange(
    startRef: string,
    endRef: string,
    count: number,
    tokens: number,
    toolPct = 100,
    effectiveTokens?: number,
): CompressibleRange {
    return {
        startRef,
        endRef,
        count,
        tokens,
        effectiveTokens: effectiveTokens ?? tokens,
        toolPct,
        textPct: 100 - toolPct,
    }
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

test("sub-floor ranges (below pipeline minimum) dropped — matches minCompressRange rejection", () => {
    const ranges = [
        makeRange("m00001", "m00002", 2, 300),
        makeRange("m00003", "m00004", 2, 200),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 0, "ranges below EFFECTIVE_MIN_COMPRESSIBLE_TOKENS are not recommended")
})

test("range at floor boundary survives, below it drops", () => {
    const kept = [makeRange("m00001", "m00002", 2, EFFECTIVE_MIN_COMPRESSIBLE_TOKENS)]
    assert.equal(filterRecommendedRanges(kept, [], OPTS).length, 1)

    const dropped = [makeRange("m00001", "m00002", 2, EFFECTIVE_MIN_COMPRESSIBLE_TOKENS - 1)]
    assert.equal(filterRecommendedRanges(dropped, [], OPTS).length, 0)
})

test("effective tokens below floor drops range even when raw tokens are large (retry-loop regression)", () => {
    // Incident ses_7fb5cbc8 floor 205: display showed "10.8K compressible" but the
    // pipeline's soft filters (protected zone + last user message) left only ~766
    // tokens → min-size rejection → model retried the same range ×10.
    const ranges = [
        makeRange("m00199", "m00207", 9, 10_800, 100, 766),
        makeRange("m00150", "m00160", 11, 8_000, 100, 6_200),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 1, "only the range with real compressible content stays")
    assert.equal(result[0].startRef, "m00150")
    assert.equal(result[0].dangerous, true, "last surviving range is marked dangerous")
})

test("all ranges sub-floor → empty result (drives nothingToCompress nudge silence)", () => {
    const ranges = [
        makeRange("m00001", "m00002", 2, 1_000),
        makeRange("m00003", "m00004", 2, 500),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 0)
})

test("mixed: sub-floor range dropped, big range kept and gets dangerous flag", () => {
    const ranges = [
        makeRange("m00001", "m00002", 2, 400),
        makeRange("m00010", "m00020", 11, 12_000),
    ]
    const result = filterRecommendedRanges(ranges, [], OPTS)
    assert.equal(result.length, 1)
    assert.equal(result[0].startRef, "m00010")
    assert.equal(result[0].dangerous, true)
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
test("config-derived floor: minCompressRange 0 disables the size floor (E2E config)", () => {
    const subFloor = [makeRange("m00001", "m00002", 2, 300)]
    const kept = filterRecommendedRanges(subFloor, [], {
        ...OPTS,
        minEffectiveTokens: 0,
    })
    assert.equal(kept.length, 1, "minCompressRange 0 → pipeline accepts any size → range shown")
})

test("config-derived floor: phantom guard still drops effective-0 ranges at floor 0", () => {
    const phantomBait = [makeRange("m00001", "m00002", 2, 900, 100, 0)]
    const kept = filterRecommendedRanges(phantomBait, [], {
        ...OPTS,
        minEffectiveTokens: 0,
    })
    assert.equal(kept.length, 0, "all-soft-filtered range is phantom bait regardless of floor")
})

test("config-derived floor: higher minCompressRange raises the floor", () => {
    const range = [makeRange("m00001", "m00002", 2, 2000)]
    const defaultFloor = filterRecommendedRanges(range, [], OPTS)
    const raisedFloor = filterRecommendedRanges(range, [], {
        ...OPTS,
        minEffectiveTokens: 5000,
    })
    assert.equal(defaultFloor.length, 1)
    assert.equal(raisedFloor.length, 0, "2000 effective tokens < 20000-char minCompressRange ÷ 4")
})
