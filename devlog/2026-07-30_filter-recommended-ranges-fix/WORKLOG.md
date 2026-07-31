# WORKLOG: Fix filterRecommendedRanges suppressing ranges at large context windows

## Changes

### `lib/messages/inject/utils.ts`
- Rewrote `filterRecommendedRanges`: removed `growthThreshold`, `lastSegmentFloor`, `suppressed`, `effectiveCompressible` logic
- New behavior: always return all input ranges, last segment marked `dangerous: true`
- Simplified `RangeFilterOptions`: removed `modelContextLimit` and `growthRatio`, only `logger` remains

### `lib/messages/inject/inject.ts`
- Updated `filterRecommendedRanges` call: `{ logger }` instead of `{ modelContextLimit, growthRatio: 0.05, logger }`
- Removed `filterSuppressed` from `nothingToCompress` calculation (always false after fix)
- Updated debug logging: removed `growthThreshold`, `lastSegmentFloor`, `suppressed` references

### Tests
- `tests/smart-nudge-gating.test.ts`: Rewritten — 8 tests covering new behavior (no suppression, last gets dangerous, tiny ranges shown, etc.)
- `tests/property-invariants.test.ts`: INV5 rewritten — property: always returns all input ranges (300 random runs)
- `tests/inject.test.ts`: 2 tests updated — old "nudge suppressed" tests now assert nudge fires

## Verification

- `npm run typecheck` — clean
- `npm test` — 942 tests pass, 0 failures

## Additional Fix: Nudge Loop Bug (lastNudgeShownTokens reset)

### Problem
When `nothingToCompress` was true (all ranges protected), `lastNudgeShownTokens` was reset to `undefined`. This caused a loop: next turn, `growthReference` fell back to stale `lastPerMessageNudgeTokens` (potentially very old), producing artificially huge growth → nudge fires → nothingToCompress again → reset → repeat every turn.

### Changes
- `lib/messages/inject/inject.ts`:
  - Removed `lastNudgeShownTokens = undefined` from `nothingToCompress` path (lines 367-369 deleted). Baseline preserved, half-threshold gate applies naturally.
  - Fixed growth display: `currentTokens - lastPerMessageNudgeTokens` → `currentTokens - (lastNudgeShownTokens ?? lastPerMessageNudgeTokens)`. Display now matches the actual growthReference used for nudge decisions.

### Tests
- `tests/inject.test.ts`:
  - Updated "pending nudge cleared when suppressed" → "pending nudge preserved when all-protected — no loop" (asserts baseline kept, not reset)
  - Added "multi-turn: all-protected does not loop (lastNudgeShownTokens stable)" — 3-turn regression test verifying baseline stability
