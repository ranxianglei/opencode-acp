# REQ: Fix Nudge Injection Loop (Issue #216)

## Problem

Three defects combine to create a self-reinforcing nudge loop:

1. **Defect 1**: `applyAnchoredNudges` runs BEFORE `nothingToCompress` is computed — nudge text (with full HOW_TO_COMPRESS rules ~1.5K tokens) injected even when filter says "nothing to compress"
2. **Defect 2**: `messageHasCompress` only counts `status === "completed"` — failed/rejected compress calls don't reset `lastNudgeShownTokens`, keeping threshold permanently halved
3. **Defect 3**: Every nudge carries full HOW_TO_COMPRESS rules — loop from 1+2 causes injection every turn, inflating context

## Evidence

From issue #216 debug logs:
- 40 compress calls, 28 failed (dominated by protected-zone rejection)
- Nudge injected every ~10s with no recommended ranges
- `Effective compressible: 0 → SUPPRESSED` but nudge text still injected

## Fix

1. **Fix 1**: Move `nothingToCompress` computation BEFORE `applyAnchoredNudges`. Gate with `shouldInjectNudge` (= `nudgeAllowed && !nothingToCompress`).
2. **Fix 2**: New `messageHasCompressAttempt()` in `query.ts` — counts ANY compress tool call regardless of status. Used for `currentTurnHasCompress` to reset pending-nudge state on failed attempts.
3. **Fix 3**: Track `compressRulesShown` flag in session state. Only append full HOW_TO_COMPRESS_RULES on first nudge; subsequent nudges omit it.

## Acceptance Criteria

- [x] Nudge text NOT injected when `nothingToCompress === true` (unless emergency override)
- [x] Failed compress calls reset `lastNudgeShownTokens` (threshold not permanently halved)
- [x] HOW_TO_COMPRESS_RULES sent only once per session
- [x] All existing tests pass
- [x] New regression tests for Defect 2
