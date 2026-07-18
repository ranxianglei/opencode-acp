# WORKLOG: Discrete 5% Check Intervals When Nudge Suppressed

## Changes

### `lib/messages/inject/inject.ts`
Added baseline advancement when nudge is suppressed (2 lines):
```typescript
if (nudgeAllowed && nothingToCompress && !emergencyOverride && currentTokens !== undefined) {
    state.nudges.lastPerMessageNudgeTokens = currentTokens
    state.nudges.lastNudgeShownTokens = undefined
}
```

Placed after `shouldInject` determination, before `shouldInjectThisTurn` assignment.

### `tests/inject.test.ts`
Added 3 tests:
1. "baseline advances when nudge suppressed — discrete 5% intervals (all protected)" — two-turn test verifying baseline advances and next check respects +5% interval
2. "baseline advances when filter suppressed — compressible too small" — filter suppression also advances baseline
3. "pending nudge cleared when suppressed — threshold resets to full" — `lastNudgeShownTokens` cleared so threshold returns to full (not halved)

## Verification

- TypeScript: 0 errors
- Tests: 755/755 pass (752 existing + 3 new)
- Node v25.9.0
