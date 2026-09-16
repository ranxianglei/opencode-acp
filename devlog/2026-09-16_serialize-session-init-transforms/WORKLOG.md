# WORKLOG - Serialize same-session state initialization and transforms

- Task ID: `2026-09-16_serialize-session-init-transforms`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-16 11:30

## 1. Summary

- **What was done** (1–3 sentences): Added a per-session FIFO mutex (`createSessionGuard` / `registry.withSessionGuard`) and in-flight init coalescing (`inflightInits` WeakMap) to `lib/state/state.ts`; wrapped every same-session mutation path — message transform pipeline, compress/decompress tool execution, event-hook duration attach+save, system-hook model-limit write+save — in the guard.
- **Why** (1–3 sentences): Same-session async work interleaved at awaits: racing initializations handed out partially loaded state, and stale transactions could persist over newer committed state (issue #404). Serialization makes the single-writer invariant hold across awaits.
- **Behavior / compatibility changes**: No persisted-format or API breakage. New exported symbols only. Steady-state fast paths unchanged (guard map empty when idle; init fast path preserved behind the inflight check). One deliberate ordering change: the init inflight check now precedes the `sessionId` fast path (required for correctness — see DESIGN §5).
- **Risk level**: Medium (touches the core request pipeline; mitigated by full-suite green + new regression tests + FIFO guard semantics that cannot deadlock across sessions).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha-1>` | fix: serialize same-session state initialization and transforms (#404) |
| `<sha-2>` | docs: fill devlog commit SHAs |

### Key Files

- `lib/state/state.ts` — `createSessionGuard()`/`SessionGuard` factory (FIFO chain mutex); `ensureSessionInitialized` split into coalescing wrapper + `runSessionInitialization`; registry exposes `withSessionGuard`.
- `lib/hooks.ts` — system hook limit write wrapped in guard; message transform restructured into `runPipeline(state)` closure invoked inside `registry.withSessionGuard(sessionID, ...)` (session branch only; ephemeral branch unguarded by design); event handler per-state apply+save wrapped per session.
- `lib/compress/range.ts` — entire `execute` body from `prepareSession` onward wrapped in `factoryCtx.registry.withSessionGuard(toolCtx.sessionID, ...)`.
- `lib/compress/decompress.ts` — same wrap from `prepareDecompressSession` onward.
- `tests/registry-stub.ts` — both stubs compose the real `createSessionGuard()` (no drift).
- `tests/session-guard.test.ts` — 7 new tests (FIFO order, cross-session independence, release-on-reject, coalescing regression, failed-init semantics, stale read-modify-write, timing-identity preservation).

## 3. Design & Implementation Notes

- **Entry point / key function**: `createSessionGuard()` in `lib/state/state.ts` — chain-based promise queue keyed by sessionId; entry deleted when the tail task finishes (no idle leak).
- **Key logic explanation**: See DESIGN.md. Critical subtlety: the init inflight check must run BEFORE the `state.sessionId === sessionId` fast path, because `runSessionInitialization` assigns `sessionId` synchronously before its first await — otherwise racing callers early-return mid-init (the original bug shape).

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit          # clean
npm run build             # clean (tsup + d.ts)
npm run test              # 1270 pass / 0 fail
node --import tsx --test tests/session-guard.test.ts   # 7/7
```

### Regression verification (per AGENTS.md §5.7.3)

Temporarily disabled the inflight check in `ensureSessionInitialized` → `tests/session-guard.test.ts` test 4 ("concurrent getOrCreate coalesces…") FAILED with `bLimitAtReturn === undefined` (the pre-fix partial-snapshot observation). Re-enabled → all green.
