# WORKLOG - Fix plugin configuration example in README

- Task ID: `2026-11-23_plugin-config-array`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-11-23 23:08

## 1. Summary

- **What was done**: Replaced the object-form `plugin` example with the array form in both README files, plus the same stale example in `AGENTS.md` (§5.4.5 dev prerelease install, found during review).
- **Why**: OpenCode's current config schema rejects the object form with `plugin: must be array`.
- **Behavior / compatibility changes**: No. Documentation only.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `c6a8737` | docs: use array form for plugin config |
| this commit | docs: add devlog for plugin config change |
| (review fix) | docs: fix object-form plugin example in AGENTS.md dev prerelease section |

### Key Files

- `README.md` — installation snippet now uses `"plugin": ["opencode-acp@stable"]`.
- `README.zh-CN.md` — same correction in the Chinese installation snippet.
- `AGENTS.md` — §5.4.5 dev prerelease install snippet corrected to `"plugin": ["opencode-acp@dev"]` (same defect, found in review).
- `devlog/2026-11-23_plugin-config-array/REQ.md` — task record and acceptance criteria.
- `devlog/2026-11-23_plugin-config-array/WORKLOG.md` — this file.

## 3. Design & Implementation Notes

- **Entry point / key function**: none; documentation-only change.
- **Key configuration items**: `plugin` in `opencode.json(c)`, array form.
- **Key logic explanation**: The CLI command `opencode plugin opencode-acp@stable --global` writes the correct array form; the manual JSON examples in the READMEs and in `AGENTS.md` were the stale parts.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Markdown changed only; no source build required.
git diff --check
```

### Test Coverage

- New/modified test files: none.
- Test count: n/a.
- Key scenarios verified: both README snippets use arrays; no remaining object-form `plugin` example.

### Results

- **PASS**: `git diff --check` clean.
- **PASS**: CI `build`, `build-artifact`, `test (22)`, `test (24)` passed before the devlog/branch-name fix.
- **FAIL before fix**: CI `pr-validation` rejected the branch name and missing devlog; this commit addresses both.

## 5. Risk Assessment & Rollback

- **Risk points**: Users on very old OpenCode versions that accepted object form may see a different shape; the array form is the current documented form.
- **Rollback method**:
  - Revert commit(s): `c6a8737` and the devlog commit.
  - Rollback impact: documentation returns to the invalid object form; not recommended.
- **Compatibility notes**: No runtime compatibility change.

## 6. Lessons Learned (optional)

- Read `AGENTS.md` section 5.1.2 and `devlog/README.md` before opening a PR; branch name and devlog are mandatory.
- Run `scripts/ci/check-pr.sh` locally before pushing when the repository provides it.

## 7. Follow-ups (optional)

- [ ] If the project starts accepting 2.x support, add a dedicated migration note; currently 2.x users should use billion-context.