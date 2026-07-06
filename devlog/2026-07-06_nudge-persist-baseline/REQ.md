# REQ — Persist nudge baseline when a growth nudge fires (#60)

## Background

GitHub issue #60 reports that the per-message context nudge fires on **every
single turn** after restarting OpenCode, showing a large "+N since last nudge"
that is actually the _total_ session usage rather than real growth since the
last nudge.

Reported against legacy DCP `0.19`, but ACP inherited the same logic and the
bug reproduces on `master` (1.9.1).

## Reproduction (from the issue + confirmed in source)

1. Long session, a nudge fires naturally when growth exceeds
   `nudgeGrowthTokens`.
2. No compress/decompress around the same time → no anchor changes.
3. Restart OpenCode.
4. Send any message → nudge fires immediately. Repeat indefinitely.

## Root cause

In `lib/messages/inject/inject.ts`, when a growth nudge fires
(`decision.shouldNudge === true`), the new baseline is written to memory:

```ts
state.nudges.lastPerMessageNudgeTokens = currentTokens
state.nudges.lastPerMessageNudgeTurn = state.currentTurn ?? 0
```

But the persistence guard only saves when anchors changed:

```ts
if (anchorsChanged) {
    saveSessionState(state, logger).catch(() => {})
}
```

`anchorsChanged` only becomes `true` on anchor add/clear (context-limit anchor,
turn/iteration anchor add, tool-output reminder). A growth-triggered nudge can
fire with `anchorsChanged === false` when:

- the turn/iteration anchor sets are already saturated (re-adding the same IDs
  does not grow the `Set`, so the size check leaves `anchorsChanged` false), or
- the last message is an assistant turn (the turn-anchor block is gated on
  `isLastMessageUser`), or
- `messagesSinceUser < iterationNudgeThreshold` (iteration anchor not added).

In those cases the in-memory baseline is updated but never reaches disk. On the
next restart `loadSessionState()` reads the stale `lastPerMessageNudgeTokens`,
growth is recomputed against the old value, the threshold is exceeded again, and
the nudge refires — every turn, for the whole session.

## Constraints

- Minimal change; do not refactor surrounding nudge logic.
- Must not change persisted state shape (backward compat, §2.6 of AGENTS.md).
- Must include a test that fails before the fix and passes after.

## Acceptance criteria

- [x] `inject.ts` save guard persists when `decision.shouldNudge === true`, not
      only when `anchorsChanged`.
- [x] New test: a growth nudge with `anchorsChanged === false` persists the new
      baseline to disk; reloaded value equals the new `currentTokens`.
- [x] Test fails on the pre-fix code (`200000 !== 255000`) and passes after.
- [x] `npm run typecheck` clean.
- [x] Full suite green (excluding the pre-existing `prompts.test.ts` bun
      nested-test incompatibility).
- [x] `npm run build` succeeds.

## Approach

Widen the single guard:

```ts
if (anchorsChanged || decision.shouldNudge) {
    saveSessionState(state, logger).catch(() => {})
}
```

Semantically correct: if a nudge fired, the baseline moved and must be
persisted. Follows the issue's proposed fix exactly.
