# DESIGN - Serialize same-session state initialization and transforms

- Task ID: `2026-09-16_serialize-session-init-transforms`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** Issue #404: `SessionState` is mutable per-session state shared across many async entry points (message transform, compress/decompress tools, event hook saves, system hook limit writes). Nothing serialized them across `await`s, so (a) concurrent initializations could observe partially loaded state, and (b) a stale in-flight transaction could persist over a newer committed one.
- **Why now?**: Reproduced deterministically with a slow-host mock; same failure shape as the baseline-reset class of bugs (#5.7.3) — silent cross-turn state corruption invisible to single-turn tests.

## 2. Goals & Non-Goals

- **Goals**: One-writer-at-a-time per session across ALL mutation paths; init coalescing so N racers pay for 1 initialization; zero steady-state overhead; no cross-session blocking; no persisted-format changes.
- **Non-Goals**: Cross-process locking; redesigning the debounced save queue (#384); v2 runtime support (#395 → billion-context#735).

## 3. Current Architecture

- **How it works today**: `SessionStateRegistry.states: Map<sessionId, SessionState>`. The transform hook calls `getOrCreate` → `ensureSessionInitialized` (idempotency via `state.sessionId === sessionId`, which was assigned synchronously pre-first-await), then a long mutate pipeline, then `saveContext`/`saveSessionState`. Tools call `prepareSession` → `ensureSessionInitialized` directly on the registry state. Event/system hooks grab state by id and write+save.
- **Pain points**: Every step above can interleave with another same-session trigger at any await boundary.

## 4. Proposed Architecture

- **Overview**:
  ```
  trigger (transform | tool | event | system)
        │
        ▼
  registry.withSessionGuard(sessionId, fn)   ← FIFO promise-chain mutex
        │  (await previous chain entry, then run fn exclusively)
        ▼
  fn: getOrCreate/prepareSession → mutate → save   ← single writer
  ```
- **Key components**:
  - `createSessionGuard()` (`lib/state/state.ts`): returns `{ run(sessionId, fn) }`; internal `Map<sessionId, Promise>` chain; each task enqueues before awaiting its predecessor; map entry deleted when the tail task completes → empty when idle. Rejections propagate to the caller but never poison the chain (predecessor awaited via `.catch(()=>{})`).
  - `ensureSessionInitialized`: now a coalescing wrapper over private `runSessionInitialization`. Module-level `WeakMap<SessionState, Promise<void>>` keyed by the STATE OBJECT (not session id) so soft-cap eviction + recreation starts fresh rather than awaiting a stale promise.
- **Data flow**: unchanged apart from ordering guarantees. Snapshot/restore (`restoreCompressionState`) already preserves `compressionTiming` identity — locked in by test 7.

## 5. Critical Subtleties (load-bearing)

1. **Inflight check precedes fast path.** `runSessionInitialization` assigns `state.sessionId` synchronously before its first await. If the `state.sessionId === sessionId` early-return ran first, racing callers would skip coalescing and return mid-init — the original bug. Order: inflight check → fast path → start+track.
2. **Guard granularity = whole transaction, not individual mutations.** A read-modify-write must be atomic end-to-end; wrapping only `saveSessionState` would still allow stale reads during the pipeline. Hence the transform body became `runPipeline(state)` invoked inside one guard acquisition.
3. **Ephemeral transform branch unguarded.** When no user message exists, the handler builds a throwaway `createSessionState()` per request — independent objects, nothing shared, no lock needed (locking on a synthetic key would only add overhead).
4. **Tools hold the guard across `prepareSession` (incl. permission `ask`).** In OpenCode v1 a tool runs while the session turn is paused, so no same-session transform is concurrently in flight — the lock is free in practice; if a trigger did interleave, serialization is exactly the desired behavior. No deadlock possible: guards are non-reentrant and no code path acquires two locks.
5. **Event handler skips states without sessionId** inside the guarded section (defensive; such states have no persistence identity).

## 6. Alternatives Considered

- **Lock only around save**: insufficient — stale READS during the pipeline already corrupted the snapshot being saved.
- **Module-level lock instead of registry method**: rejected — tools receive `registry` via `ToolFactoryContext`; a module singleton would duplicate ownership and complicate test stubs. Test stubs compose the real factory (`tests/registry-stub.ts`) to avoid drift.
- **Reentrant guard / ref-counting**: rejected — no nesting exists today; reentrancy invites future misuse.
