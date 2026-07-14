# WORKLOG: Nudge ranges fix — show compressible ranges when nudge anchors active

## Branch
`2026-07-14_nudge-ranges-fix` (from `master`)

## Root Cause (Recap)
`injectCompressNudges` (`lib/messages/inject/inject.ts`) had two disconnected
paths:

1. `applyAnchoredNudges` (always runs when `overMinLimit` or `overMaxLimit`)
   injects the nudge prompt **text** ("compress now…").
2. `if (decision.shouldNudge)` injects the **detailed breakdown** including
   `Compressible ranges` list.

`computeShouldNudge` is growth-gated: it returns `false` when
`growthSinceLastNudge < nudgeGrowthTokens` and `!overMaxLimit`. So when context
crossed `minContextLimit` (e.g. 20%) but growth was below the adaptive
threshold (~6K–50K), path 1 fired but path 2 didn't → the model saw
"compress now" with no ranges to target.

## Changes

### `lib/messages/inject/inject.ts`
- Introduced `hasActiveNudgeAnchors` = any of `contextLimitAnchors`,
  `turnNudgeAnchors`, `iterationNudgeAnchors` is non-empty.
- Broadened the detailed-breakdown block:
  `if (decision.shouldNudge)` → `if (decision.shouldNudge || hasActiveNudgeAnchors)`.
- Kept the growth-cadence-gated side effects inside a nested
  `if (decision.shouldNudge)` block so they still only fire on real growth:
  - `maxLimit` strong alert text (`tipsText`)
  - `state.nudges.lastNudgeShownTokens = currentTokens` baseline update
  - `buildCompressedBlockGuidance` block aging guidance

### `tests/inject.test.ts`
- Added regression test: "breakdown + compressible ranges injected when
  anchors active but growth below threshold (issue #27)".
  - `modelContextLimit = 1_000_000`, `minContextLimit = 200_000`,
    `maxContextLimit = 500_000`.
  - `lastPerMessageNudgeTokens = 205_000`, assistant with `input=200K, output=10K`
    → `currentTokens = 210K`, growth = 5K (< 50K threshold).
  - Last message is user → `turnNudgeAnchors` populated.
  - Asserts:
    - `shouldInjectThisTurn === false` (growth cadence preserved).
    - `turnNudgeAnchors.size > 0`.
    - suffix text includes `"Breakdown:"`.
    - suffix text includes `"Compressible ranges"` (the fix).
    - `lastNudgeShownTokens === undefined` (growth-gated side effect NOT fired).
    - suffix text does NOT include `"Context limit reached — compress now"`.

## Verification
- TypeScript: pass.
- Tests: **667 pass**, 0 fail (666 prior + 1 new).
- Build: success.
- CI check (`scripts/ci/check-pr.sh`): all pass.

## Risk
Low. The change only ADDS the breakdown output to a case where the model was
already being told "compress now" (via `applyAnchoredNudges`). The
growth-gated side effects (`lastNudgeShownTokens`, maxLimit alert, block aging)
remain correctly gated, so nudge cadence is unchanged.

## Not Changed
- No changes to `computeShouldNudge`, `applyAnchoredNudges`, or the anchor
  collection logic.
- No changes to prompt templates.
