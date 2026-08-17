# REQ - Move Changelog to separate file

- Task ID: `2026-08-17_changelog-separate-file`
- Home Repo: `opencode-acp`
- Created: 2026-08-17
- Status: InProgress
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/318 (HaleTom, [Feature]: Move Changelog to separate file)

## 1. Background & Problem Statement

- **Context**: The full release history (all `### v{VERSION}` entries) is embedded in `README.md` (~810 lines) and `README.zh-CN.md` (~765 lines). Every release prepends a new entry to the middle of a 1300-line README, making the main documentation file noisy and hard to scan.
- **Current behavior (symptom)**: Readers looking for install/config have to scroll past the entire changelog (or the README is the dominant content of the repo's main file).
- **Expected behavior**: Changelog lives in dedicated `CHANGELOG.md` / `CHANGELOG.zh-CN.md` files; READMEs keep a short pointer section. CI version-bump changelog check points at the new files.
- **Impact**: Repo hygiene / DX. No runtime behavior.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: n/a (repo-hygiene change)
  - OS/Arch: n/a
- **Minimal reproduction steps**: n/a
- **Relevant configuration**: none

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no npm package content change (CHANGELOG files are not in `verify-package.mjs`'s required list — README.md stays packaged).
  - `scripts/ci/check-pr.sh` check 4 must keep working: on version bump it greps `### v{VERSION}` — it must be repointed from README files to CHANGELOG files.
  - AGENTS.md release instructions (§5.4.2) and the rules table must document the new location.
  - Entry format unchanged: `### v{VERSION} — Title (PR #NNN)` + Problem/Fix/Files/Install.
- **Non-Goals** (explicitly out of scope):
  - No trimming of old entries (full history moves verbatim).
  - No GitHub Releases migration.
  - No auto-generated changelog tooling.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `CHANGELOG.md` starts with `# Changelog` and contains all entries that were under `## Changelog` in README.md (top entry `### v1.14.21`).
  - [x] `CHANGELOG.zh-CN.md` starts with `# 更新日志` and contains all entries that were under `## 更新日志` in README.zh-CN.md.
  - [x] README.md / README.zh-CN.md retain a short pointer section (heading + one line link).
  - [x] `scripts/ci/check-pr.sh` check 4 verifies `CHANGELOG.md` / `CHANGELOG.zh-CN.md` (change-detection + version-string grep) instead of the READMEs.
  - [x] AGENTS.md references updated (rules table §5.1.1, PR checks table §5.4.1, release step 2 §5.4.2, prerelease step 3).
  - [x] No remaining reference anywhere in repo binds changelog to README files.
- **Performance / Stability**: n/a
- **Regression**:
  - [x] Full test suite passing (unchanged code paths — docs/CI script only).
  - [x] `scripts/ci/check-pr.sh` passes for this branch (version unchanged → check skipped).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `README.md` (section 491–1301 replaced by pointer), `README.zh-CN.md` (section 445–1210 replaced by pointer)
  - new `CHANGELOG.md`, new `CHANGELOG.zh-CN.md`
  - `scripts/ci/check-pr.sh` (check 4)
  - `AGENTS.md` (4 reference sites)
  - `devlog/2026-08-17_changelog-separate-file/` (this REQ + WORKLOG)
- **Risks**: Low. Only coupling is the CI grep target — updated in the same commit. npm packaging unaffected (CHANGELOG not packaged; README still is).
- **Rollback strategy**: revert the single commit.
