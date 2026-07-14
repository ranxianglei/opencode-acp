# REQ: Stale contextLimitAnchors Fix (v2)

## Problem

User reported (dog/opencode-acp#27): after Bug 20 fix (PR #139) and growth floor fix (PR #140), the
session still injected "⚠️ Context limit reached" nudge at only 103.5K tokens on a 1M model (10.35%
usage) — far below both `maxContextLimit` and `minContextLimit` (both at 20% = 200K).

## Root Cause

`lib/messages/inject/inject.ts` anchor lifecycle has an asymmetry:

- `contextLimitAnchors` are **populated** when `overMaxLimit` is true (L171-184).
- They are **cleared** only when `currentTurnHasCompress` is true (L104-109).
- When context drops below `maxLimit` via another mechanism (OpenCode compaction, external message
  deletion) without a compress call in the current turn, the anchors persist indefinitely.

`applyAnchoredNudges` (`lib/messages/inject/utils.ts:515-516`) injects `prompts.contextLimitNudge`
whenever `contextLimitAnchors.size > 0`. The template (`lib/prompts/context-limit-nudge.ts`) always
says "⚠️ Context limit reached" — no conditional variant. Result: stale anchors → perpetual false
"limit reached" alert.

## Fix

Add an `else` branch after the `if (overMaxLimit)` block that clears `contextLimitAnchors` when
context is no longer over the max limit:

```typescript
if (overMaxLimit) {
    // add contextLimitAnchors... (unchanged)
} else {
    if (state.nudges.contextLimitAnchors.size > 0) {
        state.nudges.contextLimitAnchors.clear()
        anchorsChanged = true
    }
    if (overMinLimit) {
        // turn + iteration anchors... (unchanged, re-indented)
    }
}
```

## Regression Tests

1. **State-level**: Pre-populate `contextLimitAnchors`, run nudge at context below maxLimit, assert
   anchors cleared.
2. **Integration**: With custom prompt markers, assert `contextLimitNudge` NOT injected when context
   below maxLimit, while `turnNudge` IS injected (overMinLimit + nudgeAllowed).
