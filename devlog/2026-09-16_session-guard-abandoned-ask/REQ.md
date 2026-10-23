# REQ - Session guard can leak permanently when tool execution is abandoned during a permission ask

- Task ID: `2026-09-16_session-guard-abandoned-ask`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/410
- Stacks on: PR #408 (`2026-09-16_serialize-session-init-transforms`, head `8340afa`)

## 1. Background & Problem Statement

- **Context**: PR #408 (#404) added a per-session FIFO mutex (`registry.withSessionGuard`) and wrapped the *entire* `compress`/`decompress` tool `execute()` body in it — including `prepareSession()`, whose **first** statement is the interactive host permission prompt `await toolCtx.ask(...)`.
- **Current behavior (bug)**: The guard releases in a `finally`. If the host ever **abandons** the tool execution without settling the `execute` promise — session deleted, user aborts the turn, or a process-level cancel that drops the continuation instead of rejecting it — the `ask()` await never settles, so `run()` never returns, so the `finally` never runs, so `release()` is never called. The per-session chain entry stays pending forever.
- **Expected behavior**: Abandoning or interrupting a tool call must not wedge the session. A later same-session operation (transform / other tool / event-hook save) must still be able to acquire the guard and complete.
- **Impact**: Every subsequent same-session operation awaits the guard forever → the session wedges until the opencode process restarts. Cross-session work is unaffected (per-session chains). This turns what was previously a stuck *single* tool call into a stuck *whole session* — the new invariant from #408 widens the blast radius of an abandoned prompt.
- **Provenance**: Filed as follow-up during analysis of #404 / PR #408; recorded verbatim in `devlog/2026-09-16_serialize-session-init-transforms/WORKLOG.md` ("guard leak if a host abandons (without rejecting) tool execution while the guard spans a permission ask").

## 2. Reproduction (if applicable)

- **Environment**: Node 22/24, any OS — in-process, deterministic once abandonment is simulated.
- **Minimal reproduction steps** (simulated; live v1 interrupt semantics could not be exercised from this sandbox):
  1) Drive the real compress-range tool `.execute(args, toolCtx)` where `toolCtx.ask` returns a promise that **never settles** (the abandonment shape).
  2) Fire it without awaiting (host dropped it).
  3) Call `registry.withSessionGuard(sameSession, fn)` concurrently → pre-fix it hangs forever; post-fix it completes.
- **Empirical confirmation against the real guard** (standalone): task 1 = `guard(sid, () => new Promise(() => {}))` (never settles); task 2 same session after 20 ms → task 2 does NOT complete within 300 ms. Output: `t2 completed? false` / `WEDGE CONFIRMED`.
- **Relevant configuration**: none — default config exercises the path.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no persisted-format or public-API breakage. `prepareSession` gains an OPTIONAL `{ preApproved?: boolean }` param defaulting to `false`, so existing direct/test callers (e.g. `tests/remove-prune-regression.test.ts`) still request permission internally and keep passing.
  - Serialization preserved: the bounded state-mutating transaction (fetch → init → assignMessageRefs → mutate → persist) MUST remain fully guarded end-to-end. Only the unbounded/abandonable `ask` await is moved outside.
  - No magic timeout/timer introduced (see DESIGN §6).
- **Non-Goals** (explicitly out of scope):
  - Closing the residual exposure where a host abandons mid-fetch/mid-persist (any abandonable await *inside* the guarded region would still wedge). Fully closing that needs either live v1 verification of abort semantics or a watchdog decision — deferred, see WORKLOG §5.
  - Changing guard release semantics for the normal settle/reject paths (already correct per #408 tests).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] A compress/decompress tool execution whose permission `ask` never settles does NOT hold the session guard; a concurrent same-session op acquires the guard and completes.
  - [x] Regression test FAILS on pre-fix code (ask inside the guard) and PASSES post-fix (verified by temporarily reverting `range.ts`).
  - [x] Normal (settled) permission flow is unchanged: `ask` is called exactly once, metadata title set once, state mutated under the guard.
  - [x] All six existing `withSessionGuard` call sites still serialize correctly (full suite green).
- **Performance / Stability**:
  - [x] No steady-state overhead added on the happy path (one additional function hop; no timers/allocation growth).
  - [x] Full suite green: 1272 tests, 0 failures (+1 over #408's 1271). `tsc --noEmit` clean; `npm run build` clean.
