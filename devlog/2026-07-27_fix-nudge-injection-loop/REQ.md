# REQ: Fix Nudge Injection Loop (Issue #216)

## Problem

Two defects in `lib/messages/inject/inject.ts` caused a nudge injection loop:

1. **Defect 1 — Ordering**: `applyAnchoredNudges` fired at line 305 whenever `nudgeAllowed` was true, BEFORE `nothingToCompress` was computed (line 370). This meant nudge text was injected into the suffix message even when there was nothing to compress (all ranges in protected zone, or all filtered by recommendation filter). The suffix message then had content and was NOT dropped, so the model saw a nudge with no compressible ranges.

2. **Defect 2 — Failed compress never resets nudge state**: `messageHasCompress` (query.ts:37) only recognized `status === "completed"`. When compress failed (status `"error"` — e.g., all messages filtered by protection), `currentTurnHasCompress` was false, so the nudge state was NOT reset. The halved threshold (`nudgeGrowthTokens / 2`) persisted indefinitely, causing the model to be re-nudged every turn even with minimal context growth.

## Solution

### Defect 1 Fix
- Removed the unconditional `applyAnchoredNudges` call that fired when `nudgeAllowed`
- Added a new `applyAnchoredNudges` call after `shouldInject` is computed (line 367), gated by `shouldInject`
- This ensures anchored nudges only fire when there is actually something to compress (or emergency override)

### Defect 2 Fix
- Added `messageHasCompressAttempt` in `query.ts` — recognizes ANY compress tool call regardless of status
- Changed `inject.ts` to use `currentTurnHasCompressAttempt` for the early-return block (clearing nudge state + anchors)
- Baseline adjustment logic now gated by `currentTurnHasCompress` (completed only) within the attempt block
- Result: failed compress clears the halved threshold (breaks loop) but does NOT adjust the baseline (nothing was actually compressed)

## Scope

| File | Change |
|------|--------|
| `lib/messages/query.ts` | Added `messageHasCompressAttempt` function |
| `lib/messages/inject/inject.ts` | Use `messageHasCompressAttempt` for nudge state reset; move `applyAnchoredNudges` after `shouldInject` |
| `tests/inject.test.ts` | 2 new tests: failed compress clears state without baseline change; no nudge when nothingToCompress |
| `tests/query-pure.test.ts` | 6 new tests for `messageHasCompressAttempt` (completed, error, pending, no state, non-compress, user msg) |

## Out of Scope

- Defect 3 (nudge payload self-inflation): User explicitly rejected changing the payload — "改了以后效果会降低很多"
