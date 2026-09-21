# REQ - Reconcile compaction restart and custom-storage fork recovery

- Task ID: `2026-09-16_compaction-fork-recovery`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/407 (related: #395 OpenCode V2 migration, #404 concurrency)

## 1. Background & Problem Statement

- **Context**: Two pre-existing state-recovery paths in `ensureSessionInitialized` (`lib/state/state.ts`) can restore stale or incomplete ACP state after a process restart or a session fork.
- **Current behavior (symptom)**:
    1. **Compaction-restart gap**: init sets `state.lastCompaction = findLastCompactionTimestamp(messages)` from the _current_ history _before_ loading persisted state, then restores persisted nudge anchors/baselines, message refs, and tool-cache state unconditionally. If native compaction completed after the last persist (restart in between), the restored transient fields are stale — and `updatePerTurnState` cannot reset them because `state.lastCompaction` already equals the current boundary, so its `>` comparison never fires.
    2. **Fork recovery gaps**: (a) the parent state is loaded via `loadSessionState(parentSessionId, logger)` without the child's resolved `storageDir`, so with a custom `storagePath` the parent file is never found; (b) `mapForkIds` (`lib/state/rebuild.ts`) consumes parent `byRef` keys verbatim — legacy pre-1.1.0 four-digit refs (`m0001`) never match the fork's five-digit refs (`m00001`), so parent-to-fork translation yields an empty map and inherited blocks are lost whenever the copied history no longer contains replayable compress inputs.
- **Expected behavior**: A restart immediately after native compaction resets stale transient refs/nudges/tool cache while preserving compression blocks and stats, and persists the corrected boundary. Fork recovery finds the parent state under the configured `storagePath` and normalizes legacy parent refs before translation.
- **Impact**: Stale refs/nudge baselines after restart-after-compaction; forked sessions with custom storage or legacy parent state silently lose inherited compression blocks → context overflow.

## 2. Reproduction

- **Environment**: Node 22/24, any OS.
- **Minimal reproduction steps** (encoded as unit/E2E tests in `tests/restart-compaction-fork-recovery.test.ts`):
    1. Run a session until one compress block exists; populate nudge/message-ref/tool-cache state; persist.
    2. Replace history with a compaction summary message (newer timestamp) and re-initialize the same session ID (simulated restart) → observed: stale `lastPerMessageNudgeTokens`, stale `byRef`/`byRawId`, stale anchors retained.
    3. Build a parent with a compress block under a custom `storageDir`; fork it with an input-less copied compress part and `config.storagePath` set → observed: 0 blocks restored (parent file not found at default location).
    4. Same fork flow with parent `messageIds` rewritten to four-digit refs → observed: 0 blocks restored (ref mismatch in `mapForkIds`).
- **Relevant configuration**: `storagePath` (custom storage), legacy state files written by pre-1.1.0 versions.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: persisted state format unchanged (no new required fields); legacy 4-digit refs must keep working; own-session load-time migration in `state.ts` untouched.
    - Reset semantics must match the live-compaction path: `resetOnCompaction` preserves `prune.messages` (blocks) and stats by design (Bug 2 patch).
    - No `as any` / type-assertion hacks in `lib/` changes.
    - No version bump on this feature branch (release branches only).
- **Non-Goals**: migrating/moving existing default-location files when `storagePath` changes (explicitly out of scope per existing warn-once behavior); fixing the dead `_persistedToolParameters` persistence field (observed, reported separately if warranted); concurrency work (#404) and V2 migration (#395).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] Restart after a newer native compaction resets message refs, nudge anchors/baselines, and tool cache; preserves compression blocks and stats; persists the corrected `lastCompaction` boundary.
    - [x] Restart _without_ a newer compaction still restores persisted transient state (no over-resetting).
    - [x] Fork recovery loads parent state from the resolved `storagePath` directory and persists the fork state there.
    - [x] Fork recovery normalizes legacy 4-digit parent `byRef`/`byRawId` before translation (unit + full-init paths).
    - [x] All regression tests verified to FAIL against unfixed code (stash lib changes → 4/5 fail, negative control passes; restore → 5/5 pass).
- **Performance / Stability**:
    - [x] Full suite green: 1268 tests, 0 failures; `npm run typecheck` and `npm run build` pass.
