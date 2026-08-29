# WORKLOG — Release v1.14.26

- Task ID: `2026-08-29_release-v1.14.26`
- Home Repo: `opencode-acp`
- Status: In Progress
- Updated: 2026-08-29

## 1. Summary

Release for PR #343 (issue #342 fix: growth nudges respect the `minNudgeContextPercent` floor). Version 1.14.25 → 1.14.26.

## 2. Change Log

| Commit | Description |
|--------|-------------|
| `5554101` | release: v1.14.26 — growth nudges respect the minNudgeContextPercent floor |

## 3. Verification

- master @ `574c1c4`: typecheck clean; 1036 tests pass, 0 fail.
- `check-pr.sh`: all checks passed (branch name, devlog, changelog).

## 4. Rollback Plan

Close the PR before merge — no tag/publish happens until a human merges.
