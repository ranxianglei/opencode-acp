# WORKLOG - V2 provider-checkpoint provenance guard

- Task ID: `2026-09-17_v2-checkpoint-provenance-guard`
- Branch: `2026-09-17_v2-checkpoint-provenance-guard`
- Updated: 2026-09-17

## 1. Commits

| Commit | Description |
|--------|-------------|
| (this devlog's single commit) | fix: stop inferring V2 provider-checkpoint ownership from array position; render uncorrelated checkpoints from source data |

## 2. Key Files

| File | Change |
|------|--------|
| `lib/v2/projection/normalize.ts` | `claimCheckpointRanges`: collect unclaimed candidates in the window and claim only when exactly one exists (>1 = re-expanded originals after incompatible model switch; 0 = checkpoint absent from outgoing view). `buildProviderCheckpoint`: when `outgoingMessageIndices` is empty, render `lowerCompactionText(source)` under key `source:{i}:checkpoint:source` as an opaque origin/part so the direct-tool path keeps the checkpoint's summary + recent context. |
| `lib/v2/projection/types.ts` | Doc comment on `V2ProvenanceEntry.providerCheckpoint` documenting the unsupported-window disclosure semantics, including the single-re-expanded-original residual. |
| `lib/v2/projection/restore.ts` | Review-found blocker fix: `appendRestored` skips a provider checkpoint with empty `outgoingMessageIndices` instead of rejecting the whole patch (the outgoing request already carries its information as re-expanded host-owned originals). Non-checkpoint opaque sources keep the fail-closed rejection. |
| `tests/v2-message-projection.test.ts` | 3 new tests + `switchCheckpoint` / `stringValue` helpers; review nits applied (`protected === true` pin; direct-view `valid: false` + rejection-code pin). |
| `tests/v2-context-patch.test.ts` | 1 new regression test: uncorrelated provider checkpoint compressed away → restoration accepted, originals survive by identity, full patch pipeline green. |

## 3. Test Results

- `npm run typecheck` — pass.
- `node --import tsx --test tests/v2-message-projection.test.ts tests/v2-context-patch.test.ts` — 33 pass / 0 fail (was 29 before this change).
- Full suite `npm test` — 1414/1415 pass; the single failure is `tests/soft-block.test.ts` with `EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-<pid>'` — environmental (`/tmp` read-only in this sandbox), pre-existing at HEAD, unrelated to this change. Passes on CI where `/tmp` is writable.
- Bug-catching verification (per §5.7.3 methodology): with the normalize.ts fix stashed, both `keeps re-expanded originals uncorrelated...` and `renders the provider checkpoint from source data...` FAIL at HEAD; with the fix applied they pass. The compatible-view test passes in both states by design (regression lock). The restore regression test fails against the unfixed `restore.ts` with "no exact lowered correlation".
- `npm run build` — success.

## 3b. Dual-Agent Review (AGENTS.md §5.3 + §5.6)

Two independent agents reviewed commit 71458d18:

- **Test reviewer**: APPROVE-WITH-NITS. Empirically confirmed bug-catching (test 1 fails pre-fix at `outgoingMessageIndices` deepEqual `[0,1]`; test 3 fails pre-fix on missing `source:0:checkpoint:source` part; test 2 passes in both states). Nits applied: pin `protected === true`; pin the disclosed `valid: false` direct-view state. Residual documented gap: no end-to-end decompress-through-both-views coverage exists anywhere in the suite (V1 engine-level decompress tests do not traverse V2 projection/views) — tracked as a follow-up item in the #425 thread, out of scope here.
- **Code reviewer**: REQUEST-CHANGES → **blocker fixed in follow-up commit**. Cross-module interaction: after an incompatible switch the uncorrelated checkpoint entry is opaque + non-removable, so once the engine compresses it away, `restoreMissingV2OpaqueSources` rejected every subsequent patch ("no exact lowered correlation") and `lib/v2/context.ts:187-200` preserved the raw provider request — ACP edits silently disabled for the rest of such sessions (new failure mode, violating REQ AC#4). Fix: skip (not reject) provider checkpoints with empty indices in `restore.ts`, plus regression test. Nits applied: `types.ts` comment precision; DESIGN.md §5 residual-limitation documentation (single re-expanded original ambiguity, earlier-unclaimed-checkpoint window widening, multi-message decoded checkpoints now uncorrelated).

## 4. Findings Recorded (issue #425 thread)

1. **Pre-existing**: the direct-tool view (`normalizeV2ProjectedHistory(projected, [], ...)`, `lib/v2/host.ts:45,52`) reports `valid: false` with rejection `Patchable origin source:N:part:M has no exact lowered outgoing match` for any plain user/assistant source, because patchable text origins get no lowered pointer when there is no outgoing message. Verified identical at HEAD without this diff. Functional impact today is nil (`host.ts` consumes `.messages`, which are fully built regardless of validity), but the invalid flag is misleading. Needs its own issue from a human.
2. **Environmental**: `tests/soft-block.test.ts:10` hardcodes `/tmp/opencode-dcp-dangerous-${process.pid}`; fails with EACCES wherever `/tmp` is read-only.

## 5. Lessons Learned

- Position-based ownership inference is unsafe whenever two histories can diverge (public vs model-aware). Exact identity only; ambiguity → keep everything opaque.
- Running repo-wide `npm run format` with a Prettier version that does not reproduce the committed style (local prettier 3.9.5 wraps at a different width than the committed tree) pollutes the working tree with hundreds of unrelated files. Verify `git status --porcelain` scope immediately after formatting; here the whole tree had to be reverted and the three intended files restored from backup.
- Always verify new bug-catching tests fail against the unfixed code before trusting them.
