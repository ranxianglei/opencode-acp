# WORKLOG — v1.13.7-dev.1 Dev Prerelease

## Steps

1. **Checked npm tags**: `latest` = 1.13.6, `dev` = 1.12.10-dev.1 (stale).
2. **Created worktree**: `/home/dog/projects/opencode-acp-dev-1.13.7`, branch `2026-07-25_release-v1.13.7-dev.1`, based on `github/master` at `5d67b84` (v1.13.6 merged).
3. **Bumped version**: `package.json` 1.13.6 → `1.13.7-dev.1`.
4. **Added changelog**: `### v1.13.7-dev.1` entry to both READMEs explaining this is a dev-tag sync.
5. **Created devlog**: REQ.md + WORKLOG.md.
6. **Verification**: typecheck + test + build (pending CI check).
7. **Commit + push + PR** (pending).

## Why 1.13.7-dev.1

- `1.13.6-dev.1` would be semver-lower than the already-published `1.13.6` stable.
- `1.13.7-dev.1` signals "ahead of stable 1.13.6, prerelease of what becomes 1.13.7".
- The hyphen triggers CI to use `--tag dev` and mark GitHub Release as prerelease.

## No Source Changes

This release contains zero source code changes. It is purely a version bump to
advance the npm `dev` tag. All v1.13.x features (quality gate, compress
protection, force-protect, CI fixes) are already on master.
