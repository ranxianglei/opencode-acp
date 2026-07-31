# REQ: Fix filterRecommendedRanges suppressing ranges at large context windows (Issue #251)

## Problem

`filterRecommendedRanges` used a context-relative threshold (`modelContextLimit × 5%`) to suppress compression recommendations when the "effective compressible" tokens were below the threshold. At 1M context windows (Claude Sonnet 4.5), this threshold was 50K — meaning sessions with 30-40K of genuinely compressible content never received compression recommendations, even when the nudge system correctly detected growth.

## Impact

- Sessions at 1M context never get compression recommendations until 50K+ tokens accumulate
- Nudge fires (growth ≥ threshold) but immediately suppressed → `nothingToCompress = true` → no nudge text injected
- Model never sees compressible ranges → context grows unbounded → eventually hits hard limit

## Root Cause

`filterRecommendedRanges` in `lib/messages/inject/utils.ts`:
- `growthThreshold = modelContextLimit × 0.05` (50K at 1M, 10K at 200K)
- `lastSegmentFloor = growthThreshold × 2` (100K at 1M, 20K at 200K)
- Aggregate `effectiveCompressible` (non-last ranges + excess of last range beyond floor) compared against `growthThreshold`
- If below threshold → return `[]` → `filterSuppressed = true` → `nothingToCompress = true`

## Fix

**Simplify `filterRecommendedRanges`**: remove all suppression logic. Always return all input ranges, marking the last segment as `dangerous: true`.

**Backstop**: `minCompressRange` in `range.ts:185` (5000 chars ≈ 1250 tokens) already prevents garbage compressions at the compress tool level.

**Clean up dead code**: Remove `filterSuppressed` variable from `nothingToCompress` calculation (always `false` after fix).

## Files Changed

- `lib/messages/inject/utils.ts` — rewrite `filterRecommendedRanges`, simplify `RangeFilterOptions`
- `lib/messages/inject/inject.ts` — update call site, remove `filterSuppressed`, update debug logging
- `tests/smart-nudge-gating.test.ts` — rewrite for new behavior (8 tests)
- `tests/property-invariants.test.ts` — rewrite INV5 (always returns all ranges)
- `tests/inject.test.ts` — update 2 tests for new behavior
