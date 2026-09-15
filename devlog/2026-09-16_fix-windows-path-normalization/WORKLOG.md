# WORKLOG - Fix Windows path separator normalization in protectedFilePatterns

- Task ID: `2026-09-16_fix-windows-path-normalization`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-16 01:50

## 1. Summary

- **What was done**: Fixed `normalizePath()` in `lib/protected-patterns.ts` to replace each single backslash with `/` instead of only doubled backslashes; added `tests/protected-patterns.test.ts` regression suite (ported from upstream DCP commit 5f8f33b).
- **Why**: `"\\\\"` in source is the two-character string `\\`, so the normalization was a no-op on real Windows paths (single separators), silently bypassing `protectedFilePatterns`.
- **Behavior / compatibility changes**: Yes — Windows-separator paths/patterns now match as intended. POSIX behavior unchanged (both sides normalized identically).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| TBD | fix: normalize single Windows path separators in protectedFilePatterns |

### Key Files

- `lib/protected-patterns.ts` — `normalizePath`: `replaceAll("\\\\", "/")` → `replaceAll("\\", "/")` (+ comment explaining the escape-level bug so it isn't reintroduced)
- `tests/protected-patterns.test.ts` — NEW: 8 tests covering matchesGlob Windows separators, pattern-side normalization, wildcard boundary semantics, read/multiedit/apply_patch parameter shapes, isToolNameProtected non-regression, regex metacharacter escaping

## 3. Design & Implementation Notes

- **Entry point / key function**: `normalizePath()` (private) used by `matchesGlob()` for both input path and pattern.
- **Key logic explanation**: Separators are *converted*, not stripped, so `*` still compiles to `[^/]*` and cannot cross a directory boundary. Tests build backslashes via `String.fromCharCode(92)` so a future editor/linter reformatting can't reintroduce an escaping mistake — the exact class of bug being pinned.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/protected-patterns.test.ts
node --import tsx --test tests/*.test.ts
npm run format:check
```

### Test Coverage

- New/modified test files: `tests/protected-patterns.test.ts` (new)
- Key scenarios verified: Windows path vs forward-slash pattern; forward-slash path vs Windows pattern; `*` does not cross `\`; read/multiedit/apply_patch shapes; unmatched paths still false; tool-name protection unaffected; regex metachars escaped literally.
- Bug-reproduction check: new tests must FAIL against pre-fix code (verified before commit).

### Results

- **PASS/FAIL**: PASS
- Typecheck: clean (`tsc --noEmit`)
- New suite: 8/8 pass on fixed code; 5/8 FAIL on pre-fix code (bug-reproduction verified via temporary stash of the fix)
- Full suite: 1271 tests, 1271 pass, 0 fail
- Prettier: changed files clean (`npx prettier --check` on both files). Note: repo-wide `npm run format:check` reports 452 pre-existing unformatted files unrelated to this change (left untouched to keep the diff minimal).

## 5. Risk Assessment & Rollback

- **Risk points**: Literal doubled-backslash inputs become double slashes after normalization; both sides normalize identically so matching stays consistent — contrived edge case only.
- **Rollback method**: Revert the single commit; no state format, config schema, or API changes.
- **Compatibility notes**: No persisted-state or schema impact.

## 6. Lessons Learned

- String-literal escaping bugs are invisible to casual review (`"\\\\"` reads like "a backslash"); pinning such bugs requires tests that avoid hand-written escapes (char-code construction) plus a source comment explaining why the literal looks the way it does.
