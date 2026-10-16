# WORKLOG — sticky-truncation hardening

## Changes

| File | Change |
| --- | --- |
| lib/messages/sticky-truncation.ts | `recordStickyTruncations` returns frozen count; `snapshotToolOutputs` snapshots via `extractCompletedToolOutput` (stringifies object outputs like the guards); `applyStickyTruncations` replay now overwrites non-string pristine outputs with the frozen string; doc lines for prune-on-vanish coarseness and callID reuse |
| lib/hooks.ts | Gate resolved via `applyCompressOverrides(config, dropReasoningModel ?? state)` (Major 2); `if (frozenCount > 0) saveSessionState(...)` fire-and-forget right after `recordStickyTruncations` (Major 1) |
| lib/state/state.ts | Fork branch inherits `parent.stickyTruncations` (strings only) right after parent load (Minor 4); regular restore uses declared `persisted.stickyTruncations` (Nit 7) |
| lib/messages/truncate-tools.ts | Candidate loop skips `part.tool === "compress"`, mirroring enforce-budget (Observation 8) |
| tests/emergency-truncation-switch.test.ts | 16 tests (was 12): +same-request persistence (quiet session), +provider-override cascade (positive+negative), +fork inheritance, +GC-path compress exclusion; replay/snapshot unit tests updated for non-string behavior |

## Key debugging lessons

1. **Fail-when-broken initially passed for Major 1**: the init-time "always
   save" (state.ts Bug 1) snapshots `stickyTruncations` BY REFERENCE, so a
   turn-1 freeze lands in the already-enqueued save via aliasing. The real
   failure needs turn 1 (init save, drains) + turn 2 (freezes, no other
   trigger). Test restructured accordingly; reverted fix → test fails at
   "frozen entry persisted" (file exists, entry missing).
2. **GC-path test**: `getCurrentTokenUsage` prefers provider-REPORTED usage;
   the fallback estimator undercounts tool outputs (96k chars → 3,034
   tokens). Seed the last assistant with 30k reported tokens to cross the
   threshold min(100%×40k, 40k−16,384)=23,616.
3. **countTokens is a real tokenizer**: `'x'.repeat(16000)` BPE-collapses
   below the 1,000-token candidate floor — use varied text
   (`"line of file content\n".repeat(700)` ≈ 3.9k real tokens).

## Verification

- `node --import tsx --test tests/emergency-truncation-switch.test.ts` → 16/16
- Fail-when-broken: revert Major 1 → persistence test fails; revert Major 2 →
  cascade test fails; re-applied → 16/16 again
- `npm test` → 1390/1390 (env -u BILLION_CONTEXT_PROXY)
- `npm run build` + `tsc --noEmit` clean

## 2026-10-17 — Second review round (PR #488, reviewer #1)

Findings fixed (1 MAJOR + 2 MINOR + NITs):

1. **MAJOR — compacted parts falsely frozen.** Native compaction marks
   `state.time.compacted` but keeps the FULL output on the part;
   `extractCompletedToolOutput` reports the placeholder, so the snapshot vs
   record comparison saw prior(placeholder)≠output(full) and froze the FULL
   output into `state.json` (megabytes, re-serialized every save), and replay
   later re-inflated it over native compaction. Fix: skip `time.compacted`
   parts in BOTH `snapshotToolOutputs` and `applyStickyTruncations` replay
   (still counted as `seen` so genuinely vanished calls are pruned).
2. **MINOR — prune deletions never persisted.** `applyStickyTruncations` now
   returns the prune count; hooks saves on `frozenCount > 0 || prunedCount > 0`.
3. **MINOR — guards received raw config.** Hoisted one `effectiveConfig =
   applyCompressOverrides(...)`; reasoning gate, emergency gate, AND both
   guards (`truncateLargeToolOutputs`, `enforceContextBudget`) now use the
   same resolved view, so per-provider `protectedTools` /
   `completionReserveTokens` overrides are honored by the guards the switch
   enables. (Also resolves NIT: duplicate cascade call.)
4. **NIT — silent save failure.** `saveSessionState(...).catch` now logs
   `logger.warn("Sticky truncation: failed to persist state", ...)`.
5. **NIT — fork persistence condition.** Comment added in
   `lib/state/state.ts` explaining sticky inheritance intentionally rides the
   next save instead of forcing one.

Tests: +1 unit test "compacted parts are never frozen nor replayed" (snapshot
skips; replay leaves full output, keeps entry; record on empty prior never
freezes). Suite: 17/17 in this file, 1391/1391 full (`env -u BILLION_CONTEXT_PROXY npm test`), `tsc --noEmit` clean.
