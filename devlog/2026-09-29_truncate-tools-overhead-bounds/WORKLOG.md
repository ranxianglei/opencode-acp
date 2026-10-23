# WORKLOG - Bound the overheadErrorLogged Set (truncate-tools)

- Task ID: `2026-09-29_truncate-tools-overhead-bounds`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-29 22:30

## 1. Summary

- **What was done** (1–3 sentences): Bounded the module-level `overheadErrorLogged`
  Set in `lib/messages/truncate-tools.ts` with a FIFO cap of 1024 session keys via a new
  `recordOverheadError()` helper; added dedup and eviction regression tests to
  `tests/truncate-tools.test.ts`.
- **Why** (1–3 sentences): Issue #461 — the set accumulated one key per affected session
  for the whole process lifetime with no eviction, growing unbounded on long-lived servers
  and creating cross-test state coupling.
- **Behavior / compatibility changes**: Yes — see below. Log text, level, and once-per-session
  semantics unchanged for sessions within the bound; beyond 1024 distinct broken-window
  sessions, an evicted still-active session logs one duplicate ERROR line before dedup resumes.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (single commit of this PR) | fix: bound overheadErrorLogged Set in truncate-tools (#461) |

### Key Files

- `lib/messages/truncate-tools.ts` — replaced unbounded `Set<string>` + inline add with
  exported `MAX_OVERHEAD_ERROR_SESSIONS = 1024`, private `recordOverheadError()` FIFO-evicting
  helper, and corrected the misleading comment ("stable for the life of the process" →
  session lifetime, bounded policy documented).
- `tests/truncate-tools.test.ts` — imported `MAX_OVERHEAD_ERROR_SESSIONS`; added two tests:
  per-session dedup, and set-boundedness with oldest-key eviction + duplicate-then-dedup cycle.

## 3. Design & Implementation Notes

- **Entry point / key function**: `recordOverheadError(sessionKey: string): boolean` in
  `lib/messages/truncate-tools.ts`. Returns `true` only when the ERROR should be logged.
- **Key configuration items**: `MAX_OVERHEAD_ERROR_SESSIONS = 1024` (exported constant;
  worst-case ~50 KB of short string keys).
- **Key logic explanation** (if non-trivial): Below the cap the helper is a plain
  `has`/`add` — zero extra work on the hot path. At the cap it evicts the oldest key using
  JS `Set` insertion-order iteration (`values().next().value`). Evicting a still-active
  session costs at most one duplicate ERROR line: the next hit re-inserts the key as newest
  and dedup resumes. Chosen over session-end-event eviction because bounding is
  self-contained, O(1), and holds even on crash/kill paths where lifecycle events never fire.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/truncate-tools.test.ts
npm run test        # full suite
npm run build
```

### Test Coverage

- New/modified test files: `tests/truncate-tools.test.ts` (+2 tests)
- Test count: full suite 1344 total, 1342 pass, 2 fail (pre-existing environment failures,
  unrelated — both hit the read-only `/tmp` mount: `inactive-block-decompress.test.ts`,
  `soft-block.test.ts`; neither imports truncate-tools)
- Key scenarios verified:
  - Per-session dedup: two calls with same sessionId → exactly one ERROR.
  - Boundedness: 1025 distinct sessions → 1025 errors; evicted session re-logs exactly once,
    then dedup resumes (0 further errors).
  - **Negative verification**: temporarily removing the eviction body made the eviction test
    FAIL at "evicted session must log again after eviction" while the dedup test passed —
    proving the new test pins the new behavior. Fix restored, all green.

### Results

- **PASS/FAIL**: PASS (typecheck ✓, targeted 15/15 ✓, build ✓, full suite green except the
  two pre-existing env failures above)

## 5. Risk Assessment & Rollback

- **Risk points**: Duplicate ERROR line for a still-active broken-window session only after
  >1024 other such sessions appeared in the process — accepted tradeoff, disclosed in PR/issue.
- **Rollback method**:
  - Revert commit(s): single commit of this PR
  - Rollback impact: none — no state format, config schema, or persisted data involved.
- **Compatibility notes** (data format, config schema): No

## 6. Lessons Learned (optional)

- What went well: negative verification caught nothing-to-catch but proved the test has teeth.
- What could be improved: `npm run format` runs `prettier --write .` repo-wide and master is
  not prettier-clean — running it reformatted 472 unrelated files. Recovered via
  `git checkout -- .` + selective re-application of only this change's edits. Do not run
  repo-wide format on feature branches; CI does not gate on `format:check`.
- Reusable conclusions: For module-level dedup sets keyed by session id, prefer a bounded
  FIFO (insertion-order `Set`) over lifecycle-event eviction — self-contained, crash-safe,
  O(1) below cap.
