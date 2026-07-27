# Fix: Baseline Reset on nothingToCompress

## Problem

When the growth threshold was met (`nudgeAllowed=true`) but there was nothing to compress (`nothingToCompress=true`), the code at `inject.ts:368-370` reset `lastPerMessageNudgeTokens = currentTokens`. This "ate" the accumulated growth, creating a feedback loop in short sessions (e.g., subagent sessions):

1. Context grows → growth ≥ 50K → `nudgeAllowed = true`
2. But `nothingToCompress = true` (all ranges protected by `preserveRecentMessages: 20`) → `shouldInject = false`
3. Baseline reset to current context → growth forgotten
4. Need another 50K growth before next attempt
5. Cycle repeats → model NEVER sees a nudge

Observed in `ses_0604a0a1affebNnnFMo5KiM7GD` (31 API calls, context grew 719→142K, baseline ended at 132K).

## Fix

Remove the baseline reset from the `nothingToCompress` path. Only clear `lastNudgeShownTokens` (cosmetic). The growth baseline is preserved so it accumulates until there IS something to compress.

The baseline IS still correctly reset via the compress-detection path at `inject.ts:108-156` when the model actually compresses.

## Files

- `lib/messages/inject/inject.ts` — removed `lastPerMessageNudgeTokens = currentTokens` from nothingToCompress block
- `tests/baseline-reset.test.ts` — 3 regression tests
