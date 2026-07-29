# REQ: T2/T3 Nudge Loop Fix

## Problem

When any compress attempt is detected (success or failure), `injectCompressNudges` unconditionally resets `lastTier2NudgeTokens` and `lastTier3NudgeTokens` to `undefined`. On the next turn without compress, the T2/T3 cadence check treats `undefined` as "never fired" → cadence always passes → T2/T3 immediately re-triggers.

This creates a loop:
1. T2 fires → model attempts compress
2. Compress-processing block resets `lastTier2NudgeTokens = undefined`
3. Next turn: T2 cadence check passes (undefined = never fired)
4. T2 fires again → goto 1

The loop prevents T1 recommendations from ever appearing (T2 fires first when `!shouldInject`), which also causes the secondary symptom of skill/tool outputs not being exposed for compression even after the user removes them from `protectedTools`.

## Fix

Change lines 121-122 in `inject.ts`: set `lastTier2NudgeTokens` and `lastTier3NudgeTokens` to `currentTokens` instead of `undefined`. This preserves the cadence baseline so the `growthFloor` gate applies naturally — T2/T3 won't re-fire until context grows by at least `growthFloor` tokens since the last tier nudge.

## Impact

- Fixes T2/T3 repeated injection after any compress attempt
- Allows T1 recommendations to appear after compress (previously blocked by T2 loop)
- indirectly improves the "protectedTools=[] doesn't expose outputs" issue (T2 loop was hiding T1 recommendations)
