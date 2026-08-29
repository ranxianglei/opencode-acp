# WORKLOG — Release v1.14.26

- Task ID: `2026-08-29_release-v1.14.26`
- Home Repo: `opencode-acp`
- Status: PR Open (awaiting human merge)
- Updated: 2026-08-29

## 1. Summary

Release for PR #343 (issue #342 fix: growth nudges respect the `minNudgeContextPercent` floor) **+ PR #351** (issue #344: nested `compress.providers` — per-provider/per-model overrides for ALL compress fields). Version 1.14.25 → 1.14.26.

## 2. Change Log

| Commit | Description |
|--------|-------------|
| `5554101` | release: v1.14.26 — growth nudges respect the minNudgeContextPercent floor |
| `0e12bb7` | docs: record release commit hash and check-pr result in WORKLOG |
| `4c4262d` | docs: mark release v1.14.26 WORKLOG as PR open |
| (merge) | merge master (`46014bc`, PR #351) into release branch — brings the all-field cascade into the release; CHANGELOG EN+zh extended with the #351 feature section; devlog REQ/WORKLOG scope extension |

## 3. Verification

- master @ `574c1c4`: typecheck clean; 1036 tests pass, 0 fail.
- master @ `46014bc` (incl. #351): typecheck clean; 1062 tests pass, 0 fail (verified on PR #351 CI — test 22/24 both green).
- Post-merge verification on the release branch: see §5.
- `check-pr.sh`: all checks passed (branch name, devlog, changelog).

## 4. Rollback Plan

Close the PR before merge — no tag/publish happens until a human merges.

## 5. Scope Extension — include PR #351 (2026-08-29)

- After PR #351 merged to master (`46014bc`), maintainer directed “合并了 发一个新版本”. Merged master into this release branch (clean, no conflicts) so the release ships #343 + #351 together.
- CHANGELOG.md / CHANGELOG.zh-CN.md: `### v1.14.26` entry retitled + new **Feature (#351)** section (nested `compress.providers`, 23 overridable fields, per-field cascade, nested `maxContextLimit` > flat map, 3-layer deep-merge, validation/schema/docs).
- Post-merge re-verification: full suite re-run on the release branch — see verification block above for the final tally.
- PR #352 (`docs(deprecate): mark minContextLimit + modelMinLimits deprecated`) intentionally NOT included — it is still open and is docs-only; it ships in the next release.
