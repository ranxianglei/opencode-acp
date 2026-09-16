# REQ - Serialize same-session state initialization and transforms

- Task ID: `2026-09-16_serialize-session-init-transforms`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/404

## 1. Background & Problem Statement

- **Context**: ACP keeps mutable per-session `SessionState` in a process-wide registry. Every LLM request runs the `messages.transform` hook (init + mutate + persist), and the `compress`/`decompress` tools, the `event` hook (duration attach + save) and the `system.transform` hook (model-limit write + save) also read/mutate/persist the same state.
- **Current behavior (symptom)**: Node is single-threaded but async work interleaves at every `await`. Two triggers:
  1. **Init race** — `ensureSessionInitialized` assigned `state.sessionId = sessionId` synchronously before its first await. A concurrent caller for the same session then hit the idempotency fast path and returned *partially initialized* state (persisted blocks/messageIds not yet loaded).
  2. **Stale transaction** — a transform that awaits mid-pipeline can resume after a newer transform already committed; last-write-wins persistence then stores the stale snapshot over committed state (lost updates / corrupted prune state).
- **Expected behavior**: All same-session state work is serialized; concurrent initializations coalesce into one; no caller ever observes partially initialized state; committed state is never overwritten by a stale snapshot.
- **Impact**: Intermittent data corruption in sessions under concurrency (subagent fan-out, retries, fast successive requests): lost compression blocks, wrong nudge baselines, duplicated message refs.

## 2. Reproduction (if applicable)

- **Environment**: Node 22/24, any OS — the race is in-process, timing-dependent.
- **Minimal reproduction steps**:
  1) Seed persisted state for session S (e.g. `modelContextLimit`).
  2) Fire two `getOrCreate(client, "S", ...)` calls concurrently with a slow host (`client.session.get` delayed ~25 ms).
  3) The second caller returns before `loadSessionState` completes → reads `modelContextLimit === undefined` instead of the persisted value.
- **Relevant configuration**: none — default config exercises the path.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state format unchanged; exported API only grows (`createSessionGuard`, `SessionGuard`, `registry.withSessionGuard`); internal `dcp` naming untouched.
  - Performance requirements: zero overhead on the steady-state path (fast path still returns without touching the lock map when nothing is in flight); different sessions must never block each other.
  - Resource limits: lock map must be empty when idle (no per-session leak); init-coalescing map keyed by state object (WeakMap) so eviction + recreation starts fresh.
- **Non-Goals** (explicitly out of scope):
  - Cross-process locking (out of scope for an in-process plugin).
  - Changing `saveSessionState`'s existing debounced queue semantics (#384).
  - OpenCode v2 runtime support (v2 moved to billion-context#735 per #395).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Concurrent `getOrCreate` calls for one session coalesce into a single initialization; every waiter observes fully loaded state at return time.
  - [x] Same-session tasks run FIFO through the guard; other sessions are unaffected.
  - [x] Guard releases on rejection; subsequent tasks proceed.
  - [x] Serialized read-modify-write: a stale transaction cannot persist over a newer committed value.
  - [x] Regression test FAILS when coalescing is disabled (verified by temporarily disabling it).
- **Performance / Stability**:
  - [x] Full suite green: 1270 tests, 0 failures (was 1263 before this change added 7).
  - [x] `tsc --noEmit` clean; `npm run build` clean.
