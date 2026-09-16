# DESIGN - Session guard can leak permanently when tool execution is abandoned during a permission ask

- Task ID: `2026-09-16_session-guard-abandoned-ask`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: Accepted
- Stacks on: PR #408 (`2026-09-16_serialize-session-init-transforms`)

## 1. Problem Statement

- **What problem are we solving?** Issue #410. PR #408 wraps the entire compress/decompress tool `execute()` body in `registry.withSessionGuard`. The first statement of that body is the interactive host permission prompt `await toolCtx.ask(...)`, which can wait unbounded (user away from keyboard) and can be **abandoned without settling** on session teardown / turn abort / dropped continuation. Because the guard releases in a `finally`, an unsettled `ask` means `run()` never returns → `finally` never runs → `release()` never called → the per-session chain entry stays pending forever → every later same-session operation hangs at `await previous`. The session wedges until process restart.
- **Why now?**: #408's design (DESIGN §5.4 of the serialize devlog) assumed "tools hold the guard across `prepareSession` (incl. permission `ask`)" is safe because "in OpenCode v1 a tool runs while the session turn is paused, so no same-session transform is concurrently in flight." That reasoning is correct for *normal* operation but ignores the **liveness** requirement: a mutex only protects mutual exclusion if every holder eventually releases. An abandonable await inside the critical section breaks liveness regardless of whether anyone else is waiting — the lock simply never comes back.

## 2. Goals & Non-Goals

- **Goals**: Remove the only abandonable/unbounded await from the two tool critical sections while preserving end-to-end serialization of the bounded state transaction; keep behavior identical for the settled path; no magic timers.
- **Non-Goals**: A general watchdog/timeout for stuck chain entries (deferred, see §6); closing abandonment at other in-region awaits (documented residual, see WORKLOG §5); any change to normal settle/reject release semantics.

## 3. Current Architecture (post-#408)

```
tool.execute(args, toolCtx)
   └► withSessionGuard(sessionID, () => run())      ← acquires FIFO lock
         └► run()
              ├► prepareSession(...)                 ← FIRST stmt: await toolCtx.ask(...)  ← ABANDONABLE
              ├► fetchSessionMessages                ← bounded host call
              ├► ensureSessionInitialized            ← state mutation
              ├► assignMessageRefs                   ← state mutation
              ├► ... resolve / mutate blocks ...     ← state mutation
              └► finalizeSession (save)              ← persist
   (release() in finally)
```

The defect is structural: the critical section spans an await whose settlement depends on external human/host action that may never happen.

## 4. Proposed Architecture

```
tool.execute(args, toolCtx)
   ├► requestCompressPermission(toolCtx, title)      ← OUTSIDE guard: await toolCtx.ask + metadata
   └► withSessionGuard(sessionID, () => run())       ← acquires FIFO lock
         └► run()
              ├► prepareSession(..., { preApproved: true })   ← skips internal ask
              ├► fetchSessionMessages / init / assignMessageRefs / mutate / save   ← all bounded
   (release() in finally — now guaranteed to be reachable once ask has settled or was rejected)
```

- **Key components**:
  - `requestCompressPermission(toolCtx, title): Promise<void>` (`lib/compress/pipeline.ts`) — single owner of the `ask` + `metadata({title})` side effect, shared by both tools so they cannot drift.
  - `prepareSession(ctx, toolCtx, title, opts?: { preApproved?: boolean })` — when `opts.preApproved` is true the internal prompt is skipped (caller already ran it); otherwise it requests internally, preserving the existing direct/test call contract.
  - `prepareDecompressSession(ctx, toolCtx, opts?: { preApproved?: boolean })` — same contract.
- **Data flow**: unchanged apart from *when* `ask`/metadata fire (earlier, before lock acquisition). State reads/writes still occur exclusively inside the guard.

## 5. Critical Subtleties (load-bearing)

1. **The invariant is "no abandonable await inside the critical section," not "no await at all."** Bounded awaits (fetch, init, save) are fine to stay in the region — they always settle, so `finally` always runs and the lock always releases. Only `ask` is externally-gated/abandonable, so only `ask` must move out. Moving everything out would defeat #408's purpose.
2. **`preApproved` defaults to `false`.** Existing callers (`tests/remove-prune-regression.test.ts` calls `prepareSession(ctx, toolCtx, "regression")` with a no-op mock `ask`) rely on the internal prompt path. Making the flag default-true would silently skip their prompt; keeping it opt-in preserves backward compatibility and keeps those tests meaningful.
3. **`title` is hoisted above `run()`** in `range.ts` so the same string is used for the out-of-guard prompt and the (now pre-approved) `prepareSession` call — single source of truth, no drift between the user-facing dialog title and the persisted tool metadata.
4. **No double prompt.** Post-fix each tool calls `ask` exactly once (the outer `requestCompressPermission`), and `prepare*` skips its own when `preApproved`. The settled-path observable behavior (one `ask`, one `metadata`) is byte-for-byte identical to pre-fix.
5. **Cross-session isolation preserved.** The fix does not touch the guard algorithm; per-session chains are untouched. A wedged session cannot leak into others, as before.

## 6. Alternatives Considered

- **Watchdog / timeout that force-releases a stuck chain entry.** Rejected for this change. It requires a magic threshold; too short and it releases a legitimately long-but-alive transaction (reintroducing #404's interleaving corruption); too long and it delays real recovery indefinitely. It also masks rather than removes the root cause (abandonable await inside the critical section). Kept as a documented follow-up *if* live v1 verification shows abandonment is reachable at in-region awaits beyond `ask`.
- **Wrap only persistence in the guard, not the whole transaction.** Rejected — stale reads during the pipeline already corrupt the snapshot being saved (#404 root cause). The transaction must remain atomic end-to-end.
- **Make `ask` settle via AbortSignal / pass an abort handle.** Rejected for scope — it changes the plugin↔host contract and is not needed to close the reported leak; the narrow-scope change is minimal and sufficient.
- **Catch-and-release around `ask` inside the guard (try/finally just for the prompt).** Rejected — if `ask` never settles, `finally` after it also never runs; wrapping the abandonable await in its own finally does not help because the whole `run()` body is what holds the outer lock. The only robust fix is to not hold the lock across the abandonable await.

## 7. Backward Compatibility

- No persisted-state format change. No public API removal. New exported symbol (`requestCompressPermission`) and one optional param added to `prepareSession`/`prepareDecompressSession` — additive only. Internal `dcp-*` tags untouched.
