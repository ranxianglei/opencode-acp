# REQ — Fixed Nudge Growth Threshold

## Problem

`nudgeGrowthTokens` was adaptive: `min(50K, max(6K, modelContextLimit × 5%))`. This scaled the
growth gate (and the T2/T3 tier triggers, and growthFloor) by model window size — a 262K model
nudged at 13K growth while a 1M model required 50K. User ruled this a design defect: the growth
threshold must be a fixed value, not a percentage.

## Fix

Replace the adaptive policy wrapper with a fixed default `DEFAULT_NUDGE_GROWTH_TOKENS = 50_000`.
`compress.nudgeGrowthTokens` config override remains the single tuning knob. Uniform for all
models; growthFloor (max(5000, 0.45×value)) now also uniform at 22.5K.
