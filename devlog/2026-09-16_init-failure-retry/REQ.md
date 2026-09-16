# REQ - Transient session-init failure must not permanently suppress persisted-state load

- Task ID: `2026-09-16_init-failure-retry`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/411 (filed from dual review of PR #408); related unmerged PR #408 (`2026-09-16_serialize-session-init-transforms`)

## 1. Background & Problem Statement

- **Context**: `ensureSessionInitialized` (lib/state/state.ts) marks a `SessionState` as initialized by assigning `state.sessionId = sessionId` synchronously, before any await. `getOrCreate`'s fast path (`state.sessionId === sessionId`) then treats the state as permanently initialized for the process lifetime.
- **Current behavior (bug)**: If initialization fails after that assignment — or, more commonly in practice, if `loadSessionState` swallows a transient I/O error and returns `null`, routing init down the fresh-session branch — the state is left "initialized" with no loaded persisted state. Every subsequent `getOrCreate` for that session hits the fast path and returns immediately; re-initialization never happens again. The session silently runs on a fresh empty `SessionState`: persisted compression blocks, model context limit, and nudge baselines are never loaded for the rest of the process lifetime.
- **Trigger analysis (verified during triage)**:
    - The issue's suggested repro ("mock client rejects") does NOT fail init: `getSessionParentId` (lib/state/utils.ts) catches all errors and returns `undefined`, and `loadSessionState` (lib/state/persistence.ts) catches all errors and returns `null`. Neither throws on a host-API hiccup.
    - Dominant real-world trigger: transient FS read failure (EACCES/EIO/EMFILE) → `loadSessionState` returns `null` (indistinguishable from "file absent") → init takes the fresh/fork branch silently → `sessionId` pinned → fresh state forever.
    - Throwing triggers: `saveSessionState` rejection at end of init (lib/state/state.ts fork-branch save + final saves), or a throw inside sync `rebuildCompressionState` — these abort init AFTER partial mutation but leave `sessionId` set, so no retry is ever attempted.
- **Expected behavior**: A failed initialization must be retryable. The next request for the same session re-runs full initialization and loads persisted state once the underlying condition (permissions, disk, host API) recovers.
- **Impact**: After any one-time init failure: compression blocks from previous runs invisible to the model (no summaries injected, refs re-assigned from scratch, potential duplicate block allocation), context-limit thresholds run against undefined until the next system.transform, and nothing logs beyond the single init error.

## 2. Reproduction

- **Environment**: Node 22+, non-root user (GH Actions ubuntu runner qualifies)
- **Minimal reproduction steps** (regression test in tests/registry.test.ts):
    1. Persist a session state with `modelContextLimit = 314159` via `saveSessionState`
    2. Make the stored JSON file unreadable (`chmod 0o000`)
    3. First `registry.getOrCreate(...)` → pre-fix: read error swallowed → fresh branch → limit stays `undefined`; post-fix: error propagates → init fails loudly → limit `undefined` AND `state.sessionId === null`
    4. Restore readability (`chmod 0o644`)
    5. Second `registry.getOrCreate(...)` → pre-fix: fast path returns fresh state, limit still `undefined` (BUG); post-fix: init retries, limit loaded as `314159`
- **Relevant configuration**: none (default storage path `$XDG_DATA_HOME/opencode/storage/plugin/acp/<sessionId>.json`)

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: `loadSessionState` must keep returning `null` for (a) absent files (silent) and (b) unparseable/corrupt files (warn + null). Only genuine transient I/O errors change behavior (now propagate).
    - The synchronous `sessionId` assignment before the first await must be KEPT — it is the concurrency guard that prevents a racing second caller from resetting state mid-initialization (pre-#408 idempotency design). The fix clears it on failure instead of moving it.
    - No changes to persisted state format, exported APIs beyond `loadSessionState`'s documented error contract, or internal `dcp` naming.
- **Non-Goals**:
    - No retry/backoff loop within one request (next-request retry is sufficient; init runs on every transform anyway).
    - No changes to PR #408's coalescing/mutex work (that branch picks up this fix separately; the extracted `runSessionInitialization` shape here mirrors it for clean convergence).
    - Distinguishing "corrupt file" from "transient I/O error" beyond `ENOENT` vs other error codes / SyntaxError.

## 4. Acceptance Criteria

- **Correctness**:
    - [x] `loadSessionState`: missing file → resolves `null` (no log), corrupt JSON → resolves `null` + warn, unreadable file (EACCES) → rejects with the original error; unsearchable storage directory also rejects (the removed `existsSync` pre-check hid this as "file absent")
    - [ ] `ensureSessionInitialized`: on any init failure, `state.sessionId` reset to `null` and the error re-thrown (callers log as today)
    - [ ] Next `getOrCreate` after a failed init retries full initialization and loads persisted state (regression test T1 above flips from FAIL to PASS)
- **Testing**:
    - [ ] New test in tests/registry.test.ts verifies fail-once → retry-succeeds with side-effect assertions (`modelContextLimit`, `state.sessionId`)
    - [ ] New unit tests in tests/persistence.test.ts cover the three `loadSessionState` outcomes
    - [ ] Full suite green: `npm run typecheck && npm run test && npm run build`
- **Compatibility**:
    - [ ] No version bump; no state-format change; `getSessionParentId` behavior untouched
