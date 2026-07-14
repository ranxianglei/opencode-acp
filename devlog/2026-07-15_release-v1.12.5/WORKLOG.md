# WORKLOG: Release v1.12.5

## Steps

1. Created worktree `/tmp/opencode-acp-release-1125` from `github/master` (d976c71)
2. Bumped `package.json` version 1.12.4 → 1.12.5
3. Added changelog entry to `README.md` (English) and `README.zh-CN.md` (Chinese)
4. Created devlog `devlog/2026-07-15_release-v1.12.5/REQ.md` + `WORKLOG.md`
5. CI check: `./scripts/ci/check-pr.sh 2026-07-15_release-v1.12.5 github/master`
6. Commit + push + create PR

## Contents

This release includes:

- PR #139: Bug 20 suppression format mismatch — `overMaxLimit` never suppressed after compress
- PR #140: Growth floor gate correction — `nudgeAllowed` requires `decision.shouldNudge`

## Verification

- No code changes, release-only
- CI check script validates branch name, devlog existence, changelog format
