# WORKLOG - Transient session-init failure must not permanently suppress persisted-state load

- Task ID: `2026-09-16_init-failure-retry`
- Branch: `2026-09-16_init-failure-retry` (from `origin/master` @ `06efd39`, v1.18.1)
- Reference: https://github.com/ranxianglei/opencode-acp/issues/411

## Timeline

### 1. Triage / verification (before any code change)

- Confirmed the structural bug in `lib/state/state.ts`: `ensureSessionInitialized` assigns
  `state.sessionId = sessionId` synchronously before its first await (line 308 pre-fix);
  `getOrCreate`'s fast path (`state.sessionId === sessionId`) then suppresses re-initialization
  for the process lifetime after any failed init.
- **Corrected the issue's claimed trigger** with code evidence:
    - `getSessionParentId` (lib/state/utils.ts:72-82) catches all errors → returns `undefined`. A host-API hiccup does NOT throw.
    - `loadSessionState` (lib/state/persistence.ts) caught ALL errors → returned `null`. A transient FS read failure was therefore indistinguishable from "file absent" — the dominant real-world path into the bug (silent fresh-session branch, no throw at all).
    - Throwing paths on master were only `saveSessionState` rejections at end of init and a possible throw inside sync `rebuildCompressionState` — both fire AFTER in-memory fields are applied, so low impact on their own.
- Conclusion: the issue's suggested fix alone (reset `sessionId` on failure) would NOT cover the dominant read-error→null path; both halves of the fix below are required.

### 2. Red tests first

- Added `tests/registry.test.ts` "transient init failure does not permanently suppress persisted-state load (#411)":
  persist state (modelContextLimit=314159) directly via `createSessionState` + `saveSessionState`,
  `chmod 0o000` the stored JSON, assert first `getOrCreate` yields no loaded state AND
  `state.sessionId === null`, restore perms, assert second `getOrCreate` loads 314159.
- Added `tests/persistence.test.ts` unit tests: "loadSessionState rejects on unreadable file instead of resolving null (#411)" and "loadSessionState rejects on unsearchable storage directory (#411)" (the latter added when the `existsSync` pre-check removal closed the directory-level gap).
- New tests FAILED against unfixed code as designed (registry test failed on the `sessionId === null` assertion; persistence file test resolved `null` instead of rejecting).
- Test-design note (caught during red run): seeding the persisted file THROUGH the same registry made the second `getOrCreate` hit the fast path and masked the bug — the seed must bypass the registry.
- Both tests self-skip under root (`process.getuid() === 0`) since EACCES cannot be simulated there; they run normally on this host (uid 995) and GH Actions ubuntu runners.

### 3. Fix

- `lib/state/persistence.ts` `loadSessionState`: split I/O from parsing, error-classified by code:
    - ENOENT → `null` (absent, silent — unchanged behavior; also covers the existsSync/read race).
    - EISDIR/ENOTDIR → warn + `null` (locally corrupted layout, retry cannot help — preserves old behavior for that case).
    - anything else (EACCES/EIO/EMFILE/...) → re-thrown (NEW — transient failures become init failures).
    - Parse/validation errors → warn + `null` (unchanged: "Invalid session state file, ignoring" / "Failed to load session state").
    - The `existsSync` pre-check was REMOVED: it reports false for an unsearchable directory too (stat EACCES → false), which would have kept routing directory-level permission loss into the silent "file absent" branch. `readFile` alone covers absence via ENOENT at one syscall instead of two.
- `lib/state/state.ts` `ensureSessionInitialized`: body extracted to private `runSessionInitialization(...)`
  (same shape PR #408 introduces, for clean convergence when that branch merges); the call is wrapped so that on rejection `state.sessionId = null` is set before re-throwing. The synchronous assignment inside is deliberately kept — it is the concurrency guard against racing callers resetting state mid-init. `getOrCreate`'s catch (log + continue) is unchanged.
- Verified all `state.sessionId` consumers are null-safe (logging fields, `hooks.ts:455` guard, `truncate-tools.ts:68` `?? "unknown"`, `saveSessionState` no-op on empty id). Compress-side callers (`prepareSession`, decompress) propagate the error to the tool result — an explicit tool error is preferable to silently compressing on stale/missing persisted state.

### 4. Verification

- `npx tsc --noEmit` — clean.
- `npm run test` — **1277 pass, 0 fail, 0 skipped** (was 1274; +3 new tests).
- `npm run build` — success.
- Prettier: only touched files formatted; verified HEAD versions were prettier-clean beforehand (no unrelated reformat noise).

### 5. Review follow-ups (direct fixes on the PR branch)

- Added `tests/persistence.test.ts` "loadSessionState resolves null when the state path is a directory (#411)": pins the preserved EISDIR/ENOTDIR warn+null branch (previously untested; portable across POSIX EISDIR / Windows ENOTDIR). Suite now **1278 pass, 0 fail**.
- Updated REQ.md acceptance checkboxes to reflect implemented+verified state.
- Review follow-up candidate (NOT in this PR): under a persistent write-only FS failure (reads OK, trailing save fails), every request re-runs full init and wipes accumulated in-memory compression work. Defensible fail-loud tradeoff today; consider scoping the `sessionId` reset to failures at-or-before `loadSessionState` so a successful load survives trailing-save outages.

## Files changed

| File                        | Change                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `lib/state/persistence.ts`  | `loadSessionState` propagates transient I/O errors; ENOENT/corrupt still resolve `null`                           |
| `lib/state/state.ts`        | `ensureSessionInitialized` resets `sessionId` on init failure; body extracted to `runSessionInitialization`       |
| `tests/registry.test.ts`    | Regression test: fail-once → retry loads persisted state                                                          |
| `tests/persistence.test.ts` | Unit tests: unreadable file rejects; unsearchable dir rejects; directory-path resolves null (layout preservation) |

## Independent review (agent review of PR #412 diff)

**Verdict: APPROVE.** Verified: no new concurrency race (the clear runs synchronously inside the single in-flight init's rejection handler; a second concurrent caller fast-paths on the set flag exactly as on master), deleted-file edge is correct (retry hits ENOENT → silent null → fresh branch, same as master), all `sessionId` consumers null-safe, persisted format/API/tags unchanged, no `as any`, regression test statically proven to fail without the fix.

Applied from review: added `try/finally` around the failed-init assertions in `tests/registry.test.ts` so the chmod restore runs even when an assertion throws mid-test.

Deferred follow-ups (review findings 1–2, acceptable trade-offs for v1):

- `lib/compress/pipeline.ts:70` / `lib/compress/decompress.ts:58` surface transient I/O failures as raw tool errors to the model (intended — better than master's silent empty state); optionally wrap in a friendlier "session state temporarily unavailable, retry" message later.
- While the underlying FS condition persists, every LLM request re-runs full init and logs one ERROR per request; optionally rate-limit that log later.

## Follow-ups (not in this PR)

- PR #408 (`2026-09-16_serialize-session-init-transforms`) needs the same failure handling inside its `runSessionInitialization` wrapper plus an update to its "failed init coalesces" test if it pins the old semantics.
