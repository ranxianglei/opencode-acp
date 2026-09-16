# WORKLOG - Session guard can leak permanently when tool execution is abandoned during a permission ask

- Task ID: `2026-09-16_session-guard-abandoned-ask`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-16
- Stacks on: PR #408 (`2026-09-16_serialize-session-init-transforms`, head `8340afa`)

## 1. Summary

- **What was done**: Narrowed the per-session guard scope on the two tool paths so the interactive permission prompt (`toolCtx.ask`) runs **outside** the lock; only the bounded state-mutating transaction stays inside. Extracted a shared `requestCompressPermission(toolCtx, title)` helper into `lib/compress/pipeline.ts` and gave `prepareSession` / `prepareDecompressSession` an optional `{ preApproved?: boolean }` flag so the caller can request permission up-front and skip the internal prompt.
- **Why**: Holding the session lock across an unbounded/abandonable await means a host that abandons the tool call without settling `ask()` wedges the whole session forever (#410). Moving `ask` outside the guard removes the only abandonable await from the locked region while preserving end-to-end serialization of the state transaction. It also removes the *unnecessary* lock hold during normal prompt review (a user reading a permission dialog no longer blocks legitimate same-session work).
- **Behavior / compatibility changes**: No persisted-format or public-API breakage. `prepareSession` gains an optional param defaulting to `false` (existing direct/test callers unchanged). `ask` + metadata are still invoked exactly once per tool call — just earlier, outside the guard. All six `withSessionGuard` call sites keep their existing semantics; only the two tool sites change which statements sit inside vs. outside the acquisition. **One deliberate observable delta** (flagged in review): two concurrent same-session compress/decompress calls previously had their permission *prompts* serialized behind each other under the lock; now both prompts can be live at once (each still acquires the guard only after its own prompt settles). Harmless — a prompt performs no state mutation — and arguably better UX (a user reviewing one prompt no longer blocks the other from even appearing).
- **Risk level**: Low-Medium. Touches the two tool entry points but is additive and small; mitigated by full-suite green, a new regression test verified red→green, and dual-agent review.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `see-branch` | fix(#410): move compress/decompress permission ask outside the per-session guard |
| `see-branch` | docs: add devlog (REQ/WORKLOG/DESIGN) for #410 |

### Key Files

- `lib/compress/pipeline.ts` — new exported `requestCompressPermission(toolCtx, title)` (does `ask` + `metadata({title})`). `prepareSession(ctx, toolCtx, title, opts?)` now skips the internal prompt when `opts.preApproved` is true; otherwise requests it internally (backward-compat for direct/test callers).
- `lib/compress/range.ts` — computes `title` before the guard; calls `await requestCompressPermission(toolCtx, title)` **outside** `withSessionGuard`; `run()` calls `prepareSession(..., { preApproved: true })`.
- `lib/compress/decompress.ts` — imports `requestCompressPermission`; calls it **outside** the guard; `prepareDecompressSession(ctx, toolCtx, opts?)` skips the internal prompt when `preApproved`; `run()` passes `{ preApproved: true }`.
- `tests/session-guard.test.ts` — new test `[Issue #410] an abandoned compress permission prompt does not wedge the session`: drives the real compress-range tool with a never-settling `toolCtx.ask`, asserts a concurrent same-session `registry.withSessionGuard` still completes (via `Promise.race` + timeout).

## 3. Design & Implementation Notes

- **Entry point / key function**: `requestCompressPermission` in `lib/compress/pipeline.ts` — single owner of the permission+title side effect so both tools behave identically and can never drift back to holding the lock across `ask`.
- **Key logic explanation**: See DESIGN.md. Load-bearing invariant: the guarded region must contain **no** unbounded or abandonable await. `ask` was the only such await in either tool body; every state mutation (`fetchSessionMessages` → `ensureSessionInitialized` → `assignMessageRefs` → mutate → `saveSessionState`) already ran *after* `ask`, so moving `ask` out of the guard is behavior-preserving for the settled path and leak-proof for the abandoned path.

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit          # clean
npm run build             # clean (tsup + d.ts)
npm run test              # 1272 pass / 0 fail
node --import tsx --test tests/session-guard.test.ts   # 9/9 (was 8)
```

### Regression verification (per AGENTS.md §5.7.3)

Temporarily reverted `lib/compress/range.ts` to the pre-fix shape (removed the out-of-guard `requestCompressPermission` call and dropped `{ preApproved: true }` so `ask` ran inside the guard again). The new test FAILED with `actual: 'timeout'`, `expected: 'completed'` ("same-session op must complete despite the abandoned tool execution") — i.e. it reproduces the wedge. Re-applied the fix → test PASSES. A standalone repro against the real `createSessionGuard` independently confirmed the mechanism (`WEDGE CONFIRMED`).

### Dual-agent review (AGENTS.md §5.3 / §5.6)

See REVIEW notes below (both reviewers independent; findings addressed in-place).

## 5. Residual Exposure (documented, deferred)

- If opencode v1 abandons a tool execution at any abandonable await **inside** the guarded region (e.g. mid-`fetchSessionMessages` or mid-persist), the same permanent-wedge class would still apply. Closing that fully requires either (a) live verification of v1's interrupt/cancel semantics (not possible from this sandbox — no v1 runtime available here), or (b) a watchdog/timeout that force-releases a stuck chain entry. Option (b) was deliberately NOT adopted: a magic timeout risks releasing a legitimately long-running (but alive) transaction and reintroducing the very interleaving #408 fixed. Flagged for a follow-up issue if live v1 verification confirms mid-pipeline abandonment is reachable.
