# WORKLOG - Migrate legacy 4-digit CompressionBlock boundary refs at load and fork transfer

- Task ID: `2026-09-17_legacy-block-ref-migration`
- Branch: `2026-09-17_legacy-block-ref-migration` (from master `06efd39`)
- Status: InProgress

## Changes

| File                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/message-ids.ts`                            | New exported `migrateMessageRef(ref: string): string` — 4-digit→5-digit via existing `parseMessageRef`/`formatMessageRef`; non-refs (`""`, `bN`, free text, out-of-range indices) returned unchanged                                                                                                                                                                                                                                                                                                                                               |
| `lib/state/utils.ts`                            | `loadPruneMessagesState` now migrates persisted block `startId`/`endId` through `migrateMessageRef` (own-session load path, call site `lib/state/state.ts:393`)                                                                                                                                                                                                                                                                                                                                                                                    |
| `lib/state/rebuild.ts`                          | `restoreForkCompressionState` migration of parent blocks normalizes `startId`/`endId` — needed because the parent record comes from raw persisted JSON (`loadSessionState` does not normalize blocks), bypassing `loadPruneMessagesState`; guarded with `typeof === "string"` (parent record is unvalidated JSON)                                                                                                                                                                                                                                  |
| `lib/compress/hide-consumed.ts`                 | `rangeKey` width-normalizes both sides via `migrateMessageRef` — without this, migrating only block boundaries would REGRESS batch filtering: pre-fix both sides were consistently 4-digit in legacy sessions, post-fix they would mismatch (5-digit block key vs immutable 4-digit tool input) and consumed batch-mate summaries would leak back into context. Non-string boundary values interpolate as-is (legacy persisted records may omit them despite the `string` type) — preserves the pre-fix never-matches behavior instead of throwing |
| `tests/legacy-block-boundary-migration.test.ts` | 6 new tests: helper unit test; pass-through guard; own-load migration; fork-transfer migration; full `ensureSessionInitialized` integration incl. self-healing re-save assertion; `hideConsumedCompressCalls` width-independence regression test (RED-confirmed: fails with `actual: 2` vs `expected: 1` before the rangeKey fix)                                                                                                                                                                                                                  |
| `devlog/.../REQ.md`                             | Ticket (written before implementation); impact analysis corrected after code review found the pre-fix consumer was width-matched                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Red/Green Proof (§5.7.3 discipline)

1. Wrote behavioral tests first (no fix present): **3 fail** with `actual: 'm0001'` vs `expected: 'm00001'` at all three production paths; pass-through guard test green (as designed).
    - One false alarm during RED: my simulation literals initially used 3-digit `m001`; legacy format is 4-digit `m0001`. Fixed test literals, re-ran, confirmed true behavioral RED.
2. Applied the three-site fix: **all 5 tests green**.
3. Integration test debug note: `ensureSessionInitialized` early-returns when `state.sessionId === sessionId` (lib/state/state.ts:303) — the state object must be fresh (matching `tests/rebuild.test.ts` convention); pre-setting sessionId silently skips init.

## Verification

- `npm run typecheck`: pass
- `npm run build`: pass
- Full suite `node --import tsx --test tests/*.test.ts`: **1272 tests, 1270 pass, 2 fail**
    - The 2 failures (`tests/soft-block.test.ts` EACCES mkdir `/tmp/...`; `tests/inactive-block-decompress.test.ts` toFile path guard rejecting `/tmp/...`) reproduce identically on clean master `06efd39` (verified via `git stash` baseline run) — sandbox `/tmp` is read-only here; pre-existing environment incompatibility, unrelated to this change.
- Prettier: all touched files clean. Note: `lib/message-ids.ts` line 181 has pre-existing formatting drift on master under the current Prettier version (unrelated line, left untouched to keep the diff minimal).

## Dual-agent review round (PR #416, 2026-09-17)

Two independent reviews (oracle agent unavailable — model error; two `general` agents used instead).

**Code review (§5.3): Request changes → fixed**

- MAJOR (finding 1): naive block-side-only migration would break `hideConsumedCompressCalls` batch filtering for legacy sessions (both sides were consistently 4-digit pre-fix; immutable historical tool inputs stay 4-digit forever). Fixed by width-normalizing both sides of `rangeKey` (`lib/compress/hide-consumed.ts`) with a RED-confirmed regression test.
- Self-caught regression during fix: first version of the `rangeKey` change called `migrateMessageRef` unconditionally, which crashed (`TypeError: Cannot read properties of undefined (reading 'trim')`) in 3 existing test files — legacy persisted blocks can have `undefined` boundaries despite the `string` type. Added non-string pass-through interpolation; all 25 tests across the three affected files green.
- MINOR (finding 2): missing `typeof === "string"` guard on raw persisted parent record in `rebuild.ts` — added.
- NITs: JSDoc note on inherited trim/lowercase matching semantics; REQ.md impact analysis corrected (pre-fix consumer WAS width-matched; risk was introduced by the migration itself).

**Test review (§5.6): Approve**

- All 6 tests verified against source; red/green independently reproduced via `git archive` into `.tmp/red-check`.
- Minor accepted as follow-up (not fixed here): `buildConfig()` factory omits optional `PluginConfig` fields — copied verbatim from existing `tests/rebuild.test.ts`; test files are excluded from tsconfig typecheck; `gc` present.
- Nit: devlog md files need prettier pass before commit.

## Verification (post-review-fix)

- `npm run typecheck`: pass
- `npm run build`: pass
- Full suite `node --import tsx --test tests/*.test.ts`: **1273 tests, 1271 pass, 2 fail** — same 2 pre-existing sandbox failures as clean master (`tests/soft-block.test.ts` EACCES mkdir `/tmp/...`; `tests/inactive-block-decompress.test.ts` toFile path guard rejecting `/tmp/...`; sandbox `/tmp` is read-only here).
- Prettier: all newly touched lines clean. `lib/message-ids.ts` and `lib/compress/hide-consumed.ts` carry pre-existing formatting drift on master (verified via `git show origin/master:... | prettier | diff`) on unrelated lines — left untouched to keep the diff minimal.

## Round 2: `decompress.toFile` symlink hardening (issue #415 follow-up review)

Follow-up independent reviews on issue #415 were triaged item-by-item; eight of nine were verified as V2/billion-context-scoped or not applicable to this repo (evidence recorded in the issue thread). One applied here:

- **Finding**: `decompress` `toFile` validated paths lexically only (`path.resolve` + `path.relative`, no symlink resolution), then wrote via `writeFile`, which follows links — a symlink inside an allowed root could redirect the write outside it.
- **Fix**: new `lib/compress/tofile-target.ts` — `resolveSafeToFileTarget(targetPath, { allowedDirs? })` with three fail-closed layers: (1) lexical containment, (2) physical containment via realpath of the deepest existing ancestor compared against physical allowed roots (missing roots skipped — they contain nothing), (3) refusal of an existing final-component symlink. `lib/compress/decompress.ts` now validates through it and writes via `fs/promises.open` with `O_NOFOLLOW` (POSIX) + mode `0o600`, closing the check-then-write window.
- **Tests**: `tests/decompress-tofile-symlink.test.ts` — 8 tests importing from source; fixtures live under `$TMPDIR` with injected allowed dirs (sandbox `/tmp` is read-only; production defaults untouched). Covers: accept new file / existing file / inner-root symlink chain; reject lexical traversal / absolute outside / intermediate-dir symlink escape / final-component symlink / empty path.
- **Verification**: full suite 1281 tests / 1279 pass / 2 fail — same 2 pre-existing master-baseline sandbox failures; typecheck + build pass.

## Round 2b: review fixes for the `toFile` hardening (issue #415)

Review of the round-2 commit (`7a0d154f`) surfaced three defects; all fixed here.

- **CRITICAL — `physicallyAllowed` inverted logic** (`lib/compress/tofile-target.ts`): the committed expression `realAllowedDirs.every((dir) => !containsOrIs(join(dir), physicalPath) === false) && ...some(...)` requires containment in **all** allowed roots. The defaults are two disjoint roots (`os.tmpdir()`, `~/.cache/opencode`), so no legitimate path can sit under both — with default config, **every** `toFile` call would be rejected. Fixed to `realAllowedDirs.some((dir) => containsOrIs(dir, physicalPath))` (containment in at least one existing root suffices). Regression test added: "accepts targets under either of two disjoint allowed roots" (RED against the old expression — single-root fixtures made `every` and `some` agree, which is why round-2's 8 tests missed it).
- **Node 22 compatibility** (`lib/compress/decompress.ts`): `FileHandle.writeFile()` only exists in Node ≥ 23; CI matrix is Node 22/24, so the round-2 write path would crash on Node 22. Replaced with `handle.write(Buffer.from(fileContent, "utf-8"))`.
- **Coverage gap**: added "rejects an intermediate directory symlink escaping across multiple roots" — a link inside an allowed root pointing at a second _allowed_ root stays legitimate, while a link into a third non-allowed dir is rejected (single-root fixtures cannot express this distinction).
- Docs/comments: O_NOFOLLOW noted as POSIX-only (win32 lacks the flag and relies on the lstat check); hardlinks explicitly out of scope in `tofile-target.ts` JSDoc (a hardlinked inode still writes through its target by design — the guard targets symlink redirection).
- Formatting: an intermediate hand-reformat of `decompress.ts` had drifted from Prettier style; restored via `prettier --write` so the diff vs HEAD is functional-only. All three touched files pass `prettier --check`.

**Verification (round 2b)**: typecheck pass; build pass; `tests/decompress-tofile-symlink.test.ts` 10/10; full suite **1283 tests, 1281 pass, 2 fail** — same 2 pre-existing sandbox failures as clean master baseline (`soft-block.test.ts` EACCES mkdir `/tmp`; `inactive-block-decompress.test.ts` hardcodes `/tmp/...` target rejected by the guard / read-only sandbox `/tmp`).

## Round 2c: dual-agent review of the `toFile` hardening (issue #415)

Two independent agents reviewed the final state (`2f54a147`) per §5.3 (code) and §5.6 (tests). Both verdicts: **APPROVE WITH MINORS**. All actionable findings fixed here.

**Code review findings → disposition:**

- [MINOR] Success message reported raw `${targetPath}` instead of resolved `safe.filePath` — relative inputs would tell the model the wrong location. Fixed: message now emits `safe.filePath` (`lib/compress/decompress.ts`).
- [MINOR] Residual TOCTOU: an intermediate dir swapped to a symlink _after_ validation is not covered (`O_NOFOLLOW` guards only the final component; Node has no public `openat`). Exploitable only by an actor with direct FS write access to an allowed root — outside the prompt-injection threat model. Disposition: documented as an explicit known limitation in the `resolveSafeToFileTarget` JSDoc rather than half-fixing it.
- [NIT] `fsp.open`/`write`/`close` had no try/catch — runtime write failures (EACCES/ENOSPC) threw as rejected promises instead of the consistent `Error: …` string style. Fixed: wrapped, returns `` `Error: toFile write failed: ${msg}` ``.
- No findings in performance (all async fs, ~5–7 syscalls), type safety (no `as any`/`@ts-ignore`), platform (win32 O_NOFOLLOW absence documented; case-insensitive FS fails closed), or state integrity (toFile branch mutates nothing before the write).

**Test review findings → disposition:**

- [MINOR] Missing-allowedDir fail-closed behavior untested → added "rejects a target under an allowed root that does not exist".
- [MINOR] The decompress.ts WRITE path (early-return before open, O_NOFOLLOW, 0o600, confirmation text) had zero coverage — unit tests exercise only the pure validator. Added `tests/decompress-tofile-e2e.test.ts` (new, 2 tests) following the existing `inactive-block-decompress.test.ts` harness pattern, exercising the **real default roots** end to end: (a) intermediate-dir symlink pointing at `$HOME` (not an allowed root) → rejected, escaped file asserted absent; (b) non-canonical input (`base/./restore.txt`) → written to resolved path, confirmation string asserted to contain the resolved absolute path (RED against the pre-fix raw-input message).
- [NIT] Two test names didn't match their discriminating assertions → renamed ("symlink chain" was one hop; multi-root test name foregrounded the reject clause that passes under both old and new semantics).
- [NIT] Non-ENOENT realpath failures untested → added ELOOP symlink-cycle test (asserts fail-closed reject).
- Reviewer empirically verified (scratch copy of the exact pre-fix expression from `7a0d154f`, repo untouched): both round-2b regression tests are genuinely RED against the buggy `every(containsOrIs)` semantics, and three tests would go RED against the original lexical-only validation.

**Verification (round 2c)**: typecheck pass; prettier clean on all touched files; targeted suites **14/14** (`decompress-tofile-symlink` 12 + `decompress-tofile-e2e` 2); full suite **1287 tests, 1285 pass, 2 fail** — same 2 pre-existing sandbox failures as clean master (`soft-block.test.ts` EACCES mkdir `/tmp`; `inactive-block-decompress.test.ts` hardcoded `/tmp` target); build pass (dist/index.js 486 KB).

## Open items

- [x] Dual-agent review (§5.3 code + §5.6 tests) — done, see above.
- [x] Dual-agent review of round-2 `toFile` hardening final state (incl. round-2b fixes) — done, round 2c; all actionable findings fixed.
- Issue #415: the other nine items were triaged as not applicable to this V1-only repo (see issue comment); owner pointed follow-up discussion to ranxianglei/billion-context#809.
