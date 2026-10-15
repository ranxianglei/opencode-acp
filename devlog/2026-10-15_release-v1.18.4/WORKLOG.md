# WORKLOG - Release v1.18.4

## Changes

| File | Change |
|------|--------|
| `CHANGELOG.md` | New `### v1.18.4` section at top (image archive + cascade blanket-apply guard) |
| `CHANGELOG.zh-CN.md` | New `### v1.18.4` section at top (Chinese) |
| `devlog/2026-10-15_release-v1.18.4/` | REQ + WORKLOG (this folder) |

The version bump itself (`package.json` + `package-lock.json` 1.18.3 → 1.18.4) already landed via the one-click workflow's Bump step (head commit `927fbb4d`); the lockfile stayed in sync thanks to the idempotent bump from PR #474.

## Verification

- `./scripts/ci/check-pr.sh 2026-10-15_release-v1.18.4 origin/master` → all green (branch name ✓, devlog present ✓, `### v1.18.4` header found in both changelogs ✓).
- No runtime code touched by this commit; the feature code already merged via #479 with its own CI runs green on this branch head (test 22/24, build, e2e).
