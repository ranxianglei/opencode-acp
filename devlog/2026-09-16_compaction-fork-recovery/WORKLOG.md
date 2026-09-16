# WORKLOG - Reconcile compaction restart and custom-storage fork recovery

- Task ID: `2026-09-16_compaction-fork-recovery`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-16 12:30

## 1. Summary

- **What was done** (1–3 sentences): Added a post-load compaction-boundary reconciliation in `ensureSessionInitialized` that resets stale transient state when the current history is newer than the persisted boundary; made fork recovery load parent state from the resolved `storageDir`; normalized legacy 4-digit parent refs before fork ID translation. Added 5 regression tests covering all three failure modes plus a no-regression control.
- **Why** (1–3 sentences): A restart between native compaction and the next transform left stale message refs, nudge baselines, and tool-cache entries because `updatePerTurnState`'s reset trigger compares against an already-current `lastCompaction`. Forks with custom `storagePath` or pre-1.1.0 parent state silently lost inherited compression blocks because the parent file was looked up at the default location and legacy refs never matched.
- **Behavior / compatibility changes**: Yes — restart-after-compaction now resets transient fields (parity with the live-compaction reset path) while preserving blocks/stats; persisted state format unchanged; own-session legacy-ref migration untouched.
- **Risk level**: Low — changes are confined to init/recovery paths, guarded by boundary comparison (`>`), and reuse the existing `resetOnCompaction` semantics.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `419045b` | fix: reconcile compaction restart and custom-storage fork recovery (lib + tests + REQ) |

### Key Files

- `lib/state/state.ts` — reconciliation block after `_persistedLastCompaction` merge in `ensureSessionInitialized`; `loadSessionState(parentSessionId, logger, state.storageDir)` in the fork branch.
- `lib/state/rebuild.ts` — new `normalizeParentMessageIds()` helper (4→5 digit, byRef rebuilt from byRawId); used by `mapForkIds`.
- `tests/restart-compaction-fork-recovery.test.ts` — 5 tests: restart-after-compaction reset, negative control, custom-storage fork e2e, legacy-ref unit, legacy-ref full-init e2e.

## 3. Design & Implementation Notes

- **Why reconcile at init instead of relying on `updatePerTurnState`**: `state.lastCompaction = findLastCompactionTimestamp(messages)` runs *before* the persisted load, so by the time stale fields are restored, the "newer than persisted" signal only exists as a comparison between current history and `_persistedLastCompaction`. The reconciliation uses exactly that comparison; `Math.max` keeps the merged value when the persisted boundary is newer (no spurious reset).
- **Reset scope**: `resetOnCompaction` (lib/state/utils.ts) clears tool cache, all nudge anchors/baselines, and message refs; it deliberately preserves `prune.messages` and stats (Bug 2 patch comment). This matches the issue's required semantics and gives parity with the live-compaction path. The freshly seeded `turnNudgeAnchors` (from `collectTurnNudgeAnchors`) are wiped too — the inject pipeline re-derives them per turn, identical to the live path's one-turn behavior.
- **Fork storageDir**: passing `state.storageDir` (possibly `undefined`) to the parent load is backward compatible — `getStorageDir(override)` falls back to the default directory, so default-storage forks behave exactly as before.
- **Legacy ref normalization**: mirrors the own-session migration loop in `state.ts` (`parseMessageRef`/`formatMessageRef`). `byRef` is rebuilt from `byRawId` (authoritative direction) with defensive carry-over of byRef-only entries. Non-matching keys pass through unchanged, so malformed refs behave exactly as before (skipped during translation).
- **Observation (out of scope)**: `_persistedToolParameters` is written by `saveSessionState` but never read back anywhere in `lib/` — the tool cache is re-derived each turn via `syncToolCache`. Dead persistence data; noted for a future cleanup issue if desired.

## 4. Verification

- Regression validity (per AGENTS.md §5.7.3 lesson): with lib fixes stashed, 4/5 new tests FAIL (all bug repros); negative control passes. With fixes: 5/5 pass.
- Full suite: `npm test` → 1268 tests, 0 failures.
- `npm run typecheck` clean; `npm run build` clean; Prettier applied to changed files.
