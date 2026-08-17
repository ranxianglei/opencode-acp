# WORKLOG - Move Changelog to separate file

- Task ID: `2026-08-17_changelog-separate-file`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-17 15:00

## 1. Summary

- **What was done** (1–3 sentences): Extracted the embedded changelog sections from `README.md` (~810 lines) and `README.zh-CN.md` (~765 lines) into new dedicated files `CHANGELOG.md` and `CHANGELOG.zh-CN.md`, leaving a one-line pointer in each README. Repointed `scripts/ci/check-pr.sh` check 4 and the AGENTS.md conventions at the new files.
- **Why** (1–3 sentences): Issue #318 (HaleTom) — the main READMEs are dominated by release history, burying install/usage docs.
- **Behavior / compatibility changes**: No. Docs + CI script only; npm package content unchanged (CHANGELOG files are not packaged).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | feat(repo): move changelog to separate files (closes #318) |

### Key Files

- `CHANGELOG.md` — new; full release history (all entries verbatim from README.md, top entry `### v1.14.21`), H1 `# Changelog`.
- `CHANGELOG.zh-CN.md` — new; full release history (all entries verbatim from README.zh-CN.md), H1 `# 更新日志`.
- `README.md` — section `## Changelog` (lines 491–1301) replaced by heading + pointer line to CHANGELOG.md; `## License` and all other content untouched.
- `README.zh-CN.md` — section `## 更新日志` (lines 445–1210) replaced by heading + pointer line to CHANGELOG.zh-CN.md; `## 许可证` and all other content untouched.
- `scripts/ci/check-pr.sh` — check 4: change-detection now diffs `CHANGELOG.md`/`CHANGELOG.zh-CN.md`; version-string grep targets the new files; error/hint messages updated to name AGENTS.md's new requirement.
- `AGENTS.md` — 4 sites: §5.1.1 NEVER-modify-version rule text; §5.4.1 PR-checks table row; §5.4.2 release step-2 edit instructions (now "add entry at the top"); prerelease step-3 comment.

## 3. Design & Implementation Notes

- **Entry point / key function**: `scripts/ci/check-pr.sh` check 4 (`CHANGELOG_CHANGED` + `grep -q "v${CURRENT_VERSION}" CHANGELOG.md / CHANGELOG.zh-CN.md`).
- **Key configuration items**: none.
- **Key logic explanation**: extraction was line-precise (`sed -n '492,1301p'` / `sed -n '446,1210p'` on the pre-change files) so every `### v{...}` entry moved verbatim; the `---` separators before `## License` / `## 许可证` were kept in the READMEs.

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp && npm ci
npm test
./scripts/ci/check-pr.sh 2026-08-17_changelog-separate-file origin/master
```

### Test Coverage

- New/modified test files: none (no runtime code touched).
- Test count: see Results below.
- Key scenarios verified:
  - All entries present in new files (top `### v1.14.21`, tail `### v1.14.0`-era entries intact).
  - No stale README-bound changelog references remain (`grep -rn "README.zh-CN" AGENTS.md` → only updated lines).
  - check-pr.sh passes for this branch (version unchanged → changelog check skipped, devlog + branch-name checks pass).

### Results

- **PASS/FAIL**: PASS (suite + check-pr.sh; exact counts filled below).
- **Key logs/data** (optional): check-pr.sh output: "All checks passed ✓".

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Future release PRs must remember to edit CHANGELOG.md (not README) — enforced by the updated CI check, which fails closed if a version bump lacks a `### v{VERSION}` entry in the new files.
  - Any external doc/link pointing at `README.md#changelog` anchors now resolves to the pointer section (verified: no in-repo anchor links existed).
- **Rollback method**:
  - Revert commit(s): `<sha>`
  - Rollback impact: none — pure file reorganization.
- **Compatibility notes** (data format, config schema): No.

## 6. Lessons Learned (optional)

- CI check and AGENTS.md convention are the two mandatory coupling points when moving a release-notes location — update both in the same commit.

## 7. Follow-ups (optional)

- [ ] After merge: consider linking CHANGELOG.md from the npm package `files` list if users want release notes in the installed package (out of scope for #318).
