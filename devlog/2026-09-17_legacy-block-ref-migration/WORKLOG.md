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

## Open items

- [x] Dual-agent review (§5.3 code + §5.6 tests) — done, see above.
- Issue #415: the other nine items were triaged as not applicable to this V1-only repo (see issue comment); owner asked to re-point them to ranxianglei/billion-context.
