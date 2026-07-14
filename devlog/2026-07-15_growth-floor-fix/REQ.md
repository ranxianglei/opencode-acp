# REQ - Fix growthFloor replacing nudgeGrowthTokens as primary nudge gate

- Task ID: `2026-07-15_growth-floor-fix`
- Home Repo: `opencode-acp`
- Created: 2026-07-15
- Status: Done
- Priority: P0
- Owner: awork
- References: Gitea issue dog/opencode-acp#20

## 1. Background

Commit `914f004` ("feat: growth floor gate for compress nudges") introduced an anti-thrashing growth floor but accidentally **replaced** `decision.shouldNudge` (threshold: `nudgeGrowthTokens` = 50K for 1M model) with `nudgeAllowed` (threshold: `growthFloor` = 22.5K). This lowered the effective nudge threshold by 55%, causing nudges to fire at 5.6% context usage instead of the intended ~5% growth from baseline.

## 2. Fix

`lib/messages/inject/inject.ts:285-287`: Added `decision.shouldNudge &&` to the `nudgeAllowed` condition. Now both conditions must be true: `computeShouldNudge` says growth >= nudgeGrowthTokens, AND growth >= growthFloor (anti-thrashing).

## 3. Acceptance Criteria

- [x] 688/688 tests pass
- [x] TypeScript: 0 errors
- [x] Build: success
- [x] 2 tests updated to use 55K growth (>= 50K nudgeGrowthTokens) instead of 25K
