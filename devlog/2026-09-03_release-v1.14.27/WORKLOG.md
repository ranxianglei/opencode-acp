# WORKLOG — Release v1.14.27

- Task ID: `2026-09-03_release-v1.14.27`
- Home Repo: `opencode-acp`
- Status: In Progress
- Updated: 2026-09-03

## 1. Summary

Release for PR #338 (issue #337 fix: self-disable also triggers in manual proxy mode — detect `/bili/` in provider `baseURL`) **+ PR #352** (soft-deprecate `minContextLimit` / `modelMinLimits`, docs/schema/JSDoc only) **+ PR #358** (promote npm `stable` dist-tag to 1.14.26, bookkeeping). Version 1.14.26 → 1.14.27.

## 2. Change Log

| Commit | Description |
|--------|-------------|
| `2e93281` | release: v1.14.27 — self-disable also triggers in manual proxy mode (/bili/ baseURL detection) |
| (this commit) | docs: record release commit hash and check-pr result in WORKLOG |

## 3. Verification

- Release branch @ master `6a8e531` (incl. PR #338): typecheck clean (`tsc --noEmit`, no errors).
- Full test suite on the release branch: **1077 tests pass, 0 fail** (~110 s).
- `./scripts/ci/check-pr.sh 2026-09-03_release-v1.14.27 refs/remotes/origin/master`: **all checks passed** (branch name, devlog REQ+WORKLOG, changelog version string in both files).
- Note: sandbox `node_modules` and `/tmp` are wiped between agent turns — `npm ci` re-run before verification.

## 4. Rollback Plan

Close the PR before merge — no tag/publish happens until a human merges. If already published, `npm dist-tag add opencode-acp@1.14.26 latest` restores the previous version as `latest`.
