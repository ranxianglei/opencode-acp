# WORKLOG: T2/T3 Nudge Loop Fix

## Changes

### `lib/messages/inject/inject.ts`
- Lines 121-122: Changed `lastTier2NudgeTokens = undefined` → `lastTier2NudgeTokens = currentTokens`
- Same for `lastTier3NudgeTokens`
- Added explanatory comment about why `undefined` was wrong (cadence loop)

### `tests/inject.test.ts`
- Added test: "T2 cadence: does NOT immediately re-fire after compress attempt (T2 loop bug)"
  - Phase 1: Set up T1 blocks, verify T2 fires (tier1Tokens >= nudgeGrowthTokens)
  - Phase 2: Add compress attempt, verify `lastTier2NudgeTokens` is NOT undefined
  - Phase 3: Next turn with small growth (< growthFloor), verify T2 does NOT re-fire
- Verified test FAILS without fix (reverted to `undefined`, confirmed failure)
- Verified test PASSES with fix

## Verification

- 884 tests pass, 0 failures
- TypeScript typecheck clean
- Build: 376KB bundle
