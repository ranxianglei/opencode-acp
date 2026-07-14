# REQ: Growth floor gate for compress nudges (anti-thrashing)

## Problem

After PR #134 (show ranges when anchors active), the model could see compress
nudges every turn once `minContextLimit` is crossed — even with negligible
growth (e.g., 5K tokens on a 1M model). This risks over-compression: the model
compresses, proportional baseline adjusts slightly, next turn anchors re-add,
nudge fires again with minimal new growth.

## Root Cause

PR #134 broadened the nudge output gate to `shouldNudge || hasActiveNudgeAnchors`.
While this fixed the "prompt without ranges" bug, it removed the growth cadence
protection entirely for the `overMinLimit` path (turn anchors bypass
`nudgeFrequency` interval).

## Fix

Replace the multi-condition nudge gate with a single **growth floor** gate:

```
growthFloor = max(minNudgeGrowthFloor, minNudgeGrowthRatio × nudgeGrowthTokens)
emergencyOverride = contextUsage >= emergencyThresholdPercent
nudgeAllowed = emergencyOverride || (growthSinceBaseline >= growthFloor)
```

Defaults:

- `minNudgeGrowthRatio`: 0.45 (45% of `nudgeGrowthTokens`)
- `minNudgeGrowthFloor`: 5000 (absolute floor for small-context models)
- `emergencyThresholdPercent`: "98%" (near-overflow always fires)

Examples:

- 1M model: `max(5000, 0.45×50000) = 22500` tokens growth required
- 100K model: `max(5000, 0.45×6000) = 5000` tokens growth required

Also: `minCompressRange` default 2000 → 5000 (raise the minimum compressible
content threshold, counting compressible-only as before).

## Behavior Change: `overMaxLimit` no longer forces nudge

**Pre-PR**: `decision.shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit`.
Reaching `maxContextLimit` (default 55%) unconditionally triggered nudge output.

**Post-PR**: The single gate is `nudgeAllowed = emergencyOverride || growthSinceBaseline >= growthFloor`.
Between `maxContextLimit` (55%) and `emergencyThresholdPercent` (98%), a low-growth
turn emits zero nudge output. This is the intended anti-thrashing behavior — the
model still sees compression tools via the always-on system prompt and can compress
voluntarily, but the explicit "compress now" nudge won't fire until growth accumulates.

The `maxContextLimit` percentage is still used for `tipsVariant` selection
(efficiency vs. overflow tone) but no longer acts as a growth bypass.

## Acceptance Criteria

- Growth < floor (and context < 98%) → no nudge output at all (no text, no
  breakdown, no ranges).
- Growth >= floor → full nudge output (text + breakdown + ranges + cadence).
- Context >= 98% → emergency override fires regardless of growth.
- 5000 absolute floor prevents small-context models from having threshold < 5000.
- `minCompressRange` default raised to 5000.
- All existing growth cadence tests still pass.
