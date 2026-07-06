# WORKLOG — Persist nudge baseline when a growth nudge fires (#60)

## Summary

Fixed issue #60: the per-message nudge baseline (`lastPerMessageNudgeTokens`)
was updated in memory when a growth nudge fired but not persisted to disk when
no anchors changed, causing the nudge to refire every turn after an OpenCode
restart. One-line guard widening + a regression test that reproduces the
restart-stale-baseline scenario.

## ChangeLog

| Commit        | File                            | Change                                                                                                                                         |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------ |
| (this branch) | `lib/messages/inject/inject.ts` | Save guard `if (anchorsChanged)` → `if (anchorsChanged                                                                                         |     | decision.shouldNudge)`at the end of`injectCompressNudges`, with a comment referencing #60. |
| (this branch) | `tests/inject.test.ts`          | New regression test: seeds a stale baseline on disk, fires a growth nudge with no anchor changes, reloads, asserts the new baseline persisted. |

## KeyFiles

- `lib/messages/inject/inject.ts` — `injectCompressNudges` save guard (line ~313
  post-edit). The in-memory baseline update at ~264-265 was already correct; only
  the persistence guard was too narrow.
- `tests/inject.test.ts` — `injectCompressNudges` unit tests. Added
  `saveSessionState`/`loadSessionState` imports, `XDG_DATA_HOME`-derived
  `STORAGE_DIR`, `PERSIST_SESSION` id and `cleanupPersistSession()` helper
  matching the `persistence.test.ts` pattern.
- `lib/state/persistence.ts` — read to confirm the storage path is
  `XDG_DATA_HOME`-injectable and that no other save call site covers the
  growth-nudge path (it does not).

## DesignNotes

**Why `|| decision.shouldNudge` and not a separate `saveSessionState` call
inside the `if (decision.shouldNudge)` block?** Keeping a single save site at
the end of the function preserves the existing structure (one persistence
trigger per `injectCompressNudges` invocation) and avoids a double-save when a
nudge fires _and_ anchors changed in the same pass.

**Why the test seeds the stale baseline to disk first.** The bug is
specifically about _persistence_, not the in-memory value (the in-memory value
was always updated correctly at ~264-265). A pure state assertion cannot
distinguish the fix from the bug. Pre-saving the stale 200K baseline makes the
without-fix failure read exactly like the issue report — `200000 !== 255000`
(stale value reloaded) — instead of "no file / null", which is less faithful to
the reported symptom.

**Why `setTimeout(resolve, 50)` after `injectCompressNudges`.** The save inside
`injectCompressNudges` is fire-and-forget (`saveSessionState(...).catch(() => {})`),
not awaited. The flush lets the write settle before `loadSessionState` reads
it. 50ms is far above a local file write; `persistence.test.ts` awaits
`saveSessionState` directly so writes are fast.

**Scenario engineering (the non-obvious part).** Forcing
`shouldNudge === true && anchorsChanged === false` required:

- `modelContextLimit = 1_000_000` → adaptive `nudgeGrowthTokens = 50_000`.
- `maxContextLimit = 800_000`, `minContextLimit = 200_000`,
  `currentTokens = 255_000` → `overMinLimit = true`, `overMaxLimit = false`
  (avoids the context-limit anchor branch which would set `anchorsChanged`).
- `growth = 255K − 200K = 55K ≥ 50K` → `shouldNudge = true`.
- Last message is an **assistant** turn → `isLastMessageUser === false` → the
  turn-anchor block is skipped.
- Only one message after the user → `messagesSinceUser = 1 < iterationNudgeThreshold(15)`
  → the iteration-anchor block is skipped.
- No tool parts → the tool-output reminder block is skipped.
- Result: no path sets `anchorsChanged`, so it stays `false`.

## Testing

- `npm run typecheck` — clean.
- `bun test tests/inject.test.ts` — 14/14 pass (was 13; +1 new).
- **Regression validity verified**: temporarily reverted the fix → the new test
  fails with `AssertionError: 200000 !== 255000` (the exact reported symptom);
  restored the fix → passes.
- Full suite: `bun test tests/` → 563 pass / 1 fail. The single failure is the
  pre-existing `prompts.test.ts` "system prompt overrides handle reminder tags
  safely" test, caused by bun's nested-`t.test` incompatibility (unrelated to
  this change — this branch only touches `inject.ts` and `inject.test.ts`).
- `npm run build` — success, `dist/index.js` 349.15 KB.

## Risk

**Low.** One guard widened; no state-shape change; no API change; save is still
idempotent and already fire-and-forget. The only behavioral change is that a
nudge-triggered baseline now reaches disk immediately instead of waiting for the
next anchor mutation — which is exactly the intended fix.

## Lessons

- The bug was invisible to the existing test suite because all nudge tests
  asserted on _in-memory_ state (`state.nudges.*`), never on _persisted_ state.
  Persistence behavior needs persistence-level (disk round-trip) tests — the
  `persistence.test.ts` pattern should be reused wherever a code path claims to
  "save".
- A growth-triggered nudge with no anchor change is a real, common path
  (assistant's turn, saturated anchors). The save guard must not be coupled to
  anchor mutations.

## Followups

- Release as `1.9.2` (patch) per semver — bug fix only.
- Consider auditing other `if (anchorsChanged) saveSessionState(...)`-style
  guards for the same class of bug (none found in `hooks.ts` save sites; those
  are tied to concrete mutations like deactivation, tool-cache, command exec).
