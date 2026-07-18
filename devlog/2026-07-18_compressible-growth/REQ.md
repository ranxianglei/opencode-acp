# REQ: Discrete 5% Check Intervals When Nudge Suppressed

## Problem

When the nudge is suppressed (nothing to compress — all protected or compressible too small),
the baseline (`lastPerMessageNudgeTokens`) is NOT advanced. This means:
- Total growth keeps accumulating from the original baseline
- `nudgeAllowed = true` on EVERY subsequent turn (growth always above threshold)
- The suppression check runs every turn unnecessarily
- Wasted computation and potential for confusion

## Fix

When the nudge is allowed but suppressed (`nothingToCompress && !emergencyOverride`):
1. Advance `lastPerMessageNudgeTokens` to `currentTokens`
2. Clear `lastNudgeShownTokens` (reset pending nudge → full threshold for next check)

This creates discrete 5% check intervals:
- Turn 1: growth=55K → suppressed → baseline advances to currentTokens
- Turn 2: growth=5K (from advanced baseline) → below threshold → no check
- Turn 3: growth=50K (from advanced baseline) → check fires again

The compressible validation (`filterRecommendedRanges`) and suppression logic (`filterSuppressed`,
`allProtected`) remain unchanged — they already correctly identify "nothing to compress".

## Design Discussion

User @dog proposed: "每增长 5% 的时候去做检测，检测的时候测试一下它里面实际可压缩的是不是接近于 5%"

Analysis showed the compressible validation already exists (`filterRecommendedRanges` with 5%
threshold). The missing piece was baseline advancement — without it, the check fires every turn
instead of at discrete 5% intervals.

## Acceptance Criteria

- [x] Baseline advances when nudge suppressed (all protected)
- [x] Baseline advances when nudge suppressed (filter suppressed — compressible too small)
- [x] Pending nudge cleared on suppression (threshold resets to full)
- [x] Next check fires at +5% from advanced baseline, not every turn
- [x] Emergency override unaffected
- [x] All tests pass
