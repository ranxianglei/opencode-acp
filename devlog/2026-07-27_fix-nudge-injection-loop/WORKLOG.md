# WORKLOG: Fix Nudge Injection Loop

## Branch
`2026-07-27_fix-nudge-injection-loop` from `github/master` at `f61e42b`

## Changes

### lib/messages/query.ts
- Added `messageHasCompressAttempt`: checks `part.type === "tool" && part.tool === "compress"` without status filter
- Exported alongside existing `messageHasCompress`

### lib/messages/inject/inject.ts
- Imported `messageHasCompressAttempt` from `../query`
- Replaced `messages.slice(currentTurnStart).some(...)` with `currentTurnMessages.some(...)` (extracted to variable)
- Added `currentTurnHasCompressAttempt` computation alongside existing `currentTurnHasCompress`
- Changed early-return condition from `if (currentTurnHasCompress)` to `if (currentTurnHasCompressAttempt)`
- Nudge state clearing (anchors, `lastNudgeShownTokens`, etc.) now fires on ANY compress attempt
- Baseline adjustment condition changed from `if (wasNudgeTriggered && !compressBaselineSet)` to `if (currentTurnHasCompress && wasNudgeTriggered && !compressBaselineSet)` — only successful compress adjusts baseline
- Removed unconditional `applyAnchoredNudges` call at line ~305 (fired when `nudgeAllowed`)
- Added `applyAnchoredNudges` call after `shouldInject` computation (line ~367), gated by `if (shouldInject)`

### tests/inject.test.ts
- "failed compress (status=error) clears nudge state but does NOT adjust baseline": Sets up failed compress with `status: "error"`, verifies `lastNudgeShownTokens` cleared, anchors cleared, but baseline unchanged
- "no nudge text injected when nothingToCompress despite nudgeAllowed (defect 1)": All messages in protected zone, verifies no suffix message persists

### tests/query-pure.test.ts
- 6 new tests covering `messageHasCompressAttempt` for all status variants (completed, error, pending, no state, non-compress tool, user message)

## Verification
- TypeScript: 0 errors
- Tests: 937/937 pass (929 baseline + 8 new)
