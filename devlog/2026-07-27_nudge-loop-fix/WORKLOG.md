# WORKLOG: Fix Nudge Injection Loop (Issue #216)

## Implementation

### Fix 1: Reorder applyAnchoredNudges (inject.ts)

Moved `buildCompressibleRanges` + `filterRecommendedRanges` + `nothingToCompress` computation BEFORE `applyAnchoredNudges`. Changed gate from `if (nudgeAllowed)` to `if (shouldInjectNudge)` where `shouldInjectNudge = nudgeAllowed && (!nothingToCompress || emergencyOverride)`.

Also cleaned up duplicate code blocks left from the reordering.

### Fix 2: messageHasCompressAttempt (query.ts)

New `messageHasCompressAttempt()` function: detects ANY compress tool call (regardless of `status`). Replaces `messageHasCompress` at the `currentTurnHasCompress` call site (inject.ts:106). Failed/rejected compress calls now reset `lastNudgeShownTokens`, preventing the threshold from staying permanently halved.

`messageHasCompress` (completed-only) retained for priority.ts and utils.ts — those only care about successful compressions.

### Fix 3: compressRulesShown flag (state types + inject.ts)

Added `compressRulesShown: boolean` to `Nudges` state type. Initialized `false` in `createSessionState`, `resetSessionState`, `resetOnCompaction`, and loaded from persisted state.

In inject.ts, `HOW_TO_COMPRESS_RULES` is only appended when `!state.nudges.compressRulesShown`. After first append, flag is set to `true`. Subsequent nudges omit the full rules text.

## Files Changed

- `lib/messages/inject/inject.ts` — Fix 1 (reorder) + Fix 3 (rules dedup)
- `lib/messages/query.ts` — Fix 2 (new `messageHasCompressAttempt`)
- `lib/state/types.ts` — Added `compressRulesShown` field
- `lib/state/state.ts` — Init + load `compressRulesShown`
- `lib/state/persistence.ts` — Added `compressRulesShown` to `PersistedNudges`
- `lib/state/utils.ts` — Added `compressRulesShown` to `resetOnCompaction`
- `tests/nudge-loop-fix.test.ts` — 7 new tests for Defect 2

## Verification

- typecheck: 0 errors
- Full suite: 936/936 pass (929 existing + 7 new)
