# WORKLOG: Stale contextLimitAnchors Cleanup

## Changes

### `lib/messages/inject/inject.ts`

**Lines 185-196**: Added `else` branch to clear stale `contextLimitAnchors` when
`overMaxLimit` is false. Restructured the existing `else if (overMinLimit)` as a
nested `if` inside the new `else` block.

Before:

```typescript
if (overMaxLimit) {
    // add contextLimitAnchors...
} else if (overMinLimit) {
    // add turn + iteration anchors...
}
// NO else — contextLimitAnchors never cleared when !overMaxLimit
```

After:

```typescript
if (overMaxLimit) {
    // add contextLimitAnchors...
} else {
    // Clear stale context limit anchors
    if (state.nudges.contextLimitAnchors.size > 0) {
        state.nudges.contextLimitAnchors.clear()
        anchorsChanged = true
    }

    if (overMinLimit) {
        // add turn + iteration anchors...
    }
}
```

### `tests/inject.test.ts`

Added 2 regression tests:

1. **State assertion**: stale `contextLimitAnchors` cleared when context below
   `maxContextLimit` without compress in current turn.
2. **Integration test**: `CONTEXT_LIMIT_NUDGE` prompt text NOT injected when
   context is below limit — verified via custom prompt marker. Also asserts
   `shouldInjectThisTurn === true` to confirm `applyAnchoredNudges` actually ran
   (ruling out false pass from nudge suppression).

## Verification

- TypeScript: pass
- Tests: 690 pass (688 existing + 2 new), 0 fail
- Build: pass (394K)
