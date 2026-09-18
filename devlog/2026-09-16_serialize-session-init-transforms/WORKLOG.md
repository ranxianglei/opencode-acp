# WORKLOG - Serialize same-session state initialization and transforms

- Task ID: `2026-09-16_serialize-session-init-transforms`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-16 (dual-review fix round)

## 1. Summary

- **What was done** (1–3 sentences): Added a per-session FIFO mutex (`createSessionGuard` / `registry.withSessionGuard`) and in-flight init coalescing (`inflightInits` WeakMap) to `lib/state/state.ts`; wrapped every same-session mutation path — message transform pipeline, compress/decompress tool execution, event-hook duration attach+save, system-hook model-limit write+save — in the guard.
- **Why** (1–3 sentences): Same-session async work interleaved at awaits: racing initializations handed out partially loaded state, and stale transactions could persist over newer committed state (issue #404). Serialization makes the single-writer invariant hold across awaits.
- **Behavior / compatibility changes**: No persisted-format or API breakage. New exported symbols only. Steady-state fast paths unchanged (guard map empty when idle; init fast path preserved behind the inflight check). One deliberate ordering change: the init inflight check now precedes the `sessionId` fast path (required for correctness — see DESIGN §5).
- **Risk level**: Medium (touches the core request pipeline; mitigated by full-suite green + new regression tests + FIFO guard semantics that cannot deadlock across sessions).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `571ccf0` | fix: serialize same-session state initialization and transforms (#404) |
| `see-branch` | docs: fill devlog commit SHAs (self-referential SHA omitted) |
| `see-branch` | review fixes: transform wiring regression test, event-handler cross-session parallelism, command-handler guard, prettier width wraps, REQ wording |

### Key Files

- `lib/state/state.ts` — `createSessionGuard()`/`SessionGuard` factory (FIFO chain mutex); `ensureSessionInitialized` split into coalescing wrapper + `runSessionInitialization`; registry exposes `withSessionGuard` (field intentionally not `readonly` so the wiring test can wrap it as an observation seam).
- `lib/hooks.ts` — system hook limit write wrapped in guard; message transform restructured into `runPipeline(state)` closure invoked inside `registry.withSessionGuard(sessionID, ...)` (session branch only; ephemeral branch unguarded by design); event handler per-state apply+save guarded per session AND run concurrently across sessions (`Promise.allSettled`) so one long-held guard cannot head-of-line-block other sessions' duration attachment; `/acp` command handler `getOrCreate`+permission-sync kept under the guard (getOrCreate can initialize + persist).
- `lib/compress/range.ts` — entire `execute` body from `prepareSession` onward wrapped in `factoryCtx.registry.withSessionGuard(toolCtx.sessionID, ...)`.
- `lib/compress/decompress.ts` — same wrap from `prepareDecompressSession` onward.
- `tests/registry-stub.ts` — both stubs compose the real `createSessionGuard()` (no drift).
- `tests/session-guard.test.ts` — 8 new tests (FIFO order, cross-session independence, release-on-reject, coalescing regression, failed-init semantics, stale read-modify-write, timing-identity preservation, **end-to-end transform wiring**: two concurrent same-session requests through the real `createChatMessageTransformHandler` must produce strictly nested guard enter/exit pairs).

## 3. Design & Implementation Notes

- **Entry point / key function**: `createSessionGuard()` in `lib/state/state.ts` — chain-based promise queue keyed by sessionId; entry deleted when the tail task finishes (no idle leak).
- **Key logic explanation**: See DESIGN.md. Critical subtlety: the init inflight check must run BEFORE the `state.sessionId === sessionId` fast path, because `runSessionInitialization` assigns `sessionId` synchronously before its first await — otherwise racing callers early-return mid-init (the original bug shape).

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit          # clean
npm run build             # clean (tsup + d.ts)
npm run test              # 1271 pass / 0 fail
node --import tsx --test tests/session-guard.test.ts   # 8/8
```

### Regression verification (per AGENTS.md §5.7.3)

Temporarily disabled the inflight check in `ensureSessionInitialized` → `tests/session-guard.test.ts` test 4 ("concurrent getOrCreate coalesces…") FAILED with `bLimitAtReturn === undefined` (the pre-fix partial-snapshot observation). Re-enabled → all green.

Wiring test (test 8): temporarily bypassed the transform-branch guard in `lib/hooks.ts` (body ran unguarded) → test 8 FAILED (`events === []`, no serialization observed). Restored → green. Reviewer 2 independently repeated the coalescing red/green check.

### Dual-agent review (AGENTS.md §5.3 / §5.6)

Both reviewers: **APPROVE-WITH-NITS**, zero blockers/majors; each ran tsc + full suite independently (1271/1271). Fix round applied directly to the branch:

- MAJOR (tests): missing end-to-end wiring coverage → added test 8 (above).
- MINOR: event handler awaited each session's guard sequentially (head-of-line blocking) → `Promise.allSettled` across sessions, per-session containment preserved.
- MINOR: command handler called `getOrCreate` outside any guard → wrapped with permission-sync under one acquisition.
- MINOR: two new-code prettier width violations (`state.ts`, `hooks.ts`) → wrapped.
- NIT: REQ.md "zero overhead" claim imprecise → "O(1) constant overhead".
- Follow-ups filed separately (source-marked per §5.1.3): guard leak if a host abandons (without rejecting) tool execution while the guard spans a permission ask; sticky failed-init (a transient first-request init failure permanently suppresses persisted-state load for that session until process restart — pre-existing behavior, preserved).
