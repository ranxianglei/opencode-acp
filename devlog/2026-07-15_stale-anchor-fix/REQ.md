# REQ: Stale contextLimitAnchors Cleanup

## Problem

`lib/messages/inject/inject.ts` anchor lifecycle has a gap: `contextLimitAnchors`
are populated when `overMaxLimit` is true (L171-184), but **never cleared when
`overMaxLimit` becomes false** — they are only cleared by `currentTurnHasCompress`
(L104-109).

When context drops below `maxContextLimit` without a compress call in the current
turn (e.g., via OpenCode compaction, external message deletion, or token estimate
changes), stale `contextLimitAnchors` persist indefinitely. On subsequent turns
where `nudgeAllowed` is true, `applyAnchoredNudges` injects `CONTEXT_LIMIT_NUDGE`
prompt text — which always says "⚠️ Context limit reached" — even though context
is well below the limit.

### User-Reported Symptom (dog/opencode-acp#27)

Session `ses_0a3be0cdeffezb9pLzfifH7lzK` at 103.5K tokens (10.35% of 1M model,
threshold 20% = 200K) showed "⚠️ Context limit reached" while the breakdown
correctly reported "efficiency nudge, not overflow warning" — contradictory
output. Root cause: stale `contextLimitAnchors` from earlier turns when context
was above 200K.

## Fix

Add an `else` branch at L185 that clears `contextLimitAnchors` when
`!overMaxLimit`. This ensures stale anchors are cleaned up on every turn where
context is below the max limit, regardless of whether a compress occurred.

The existing `else if (overMinLimit)` becomes a nested `if (overMinLimit)` inside
the new `else` block.

## Impact

- Fixes contradictory nudge output ("Context limit reached" + "efficiency nudge")
- Prevents model from being misled into emergency compression when context is healthy
- Independent of PR #138 (GC removal) — this bug exists on master
