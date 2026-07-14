# WORKLOG

## Commits
1. `fix: nudgeAllowed requires decision.shouldNudge (growthFloor was sole gate)` — inject.ts + tests

## Changes

### `lib/messages/inject/inject.ts`
- Line 285-288: `nudgeAllowed = emergencyOverride || (decision.shouldNudge && growth >= growthFloor)`
- Before: `nudgeAllowed = emergencyOverride || (growth >= growthFloor)` — growthFloor (22.5K) was the sole gate
- After: requires BOTH `decision.shouldNudge` (growth >= 50K nudgeGrowthTokens) AND `growth >= growthFloor` (22.5K)

### `tests/inject.test.ts`
- Test "growth floor: nudge fires when growth meets floor" → renamed to "nudge fires when growth meets nudgeGrowthTokens". Added 25K-growth suppressed assertion, 55K-growth fires assertion.
- Test "applyAnchoredNudges output suppressed" fires case: changed 25K → 55K growth.

## Results
- 688/688 tests pass
- TypeScript: 0 errors
- Build: 393.65 KB
