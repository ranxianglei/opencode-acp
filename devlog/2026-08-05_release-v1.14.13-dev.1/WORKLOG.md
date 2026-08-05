# WORKLOG — v1.14.13-dev.1 Dev Prerelease

## Steps

1. Created worktree `/tmp/opencode-acp-release-v1.14.13-dev.1` from master `8f59d9f` (PR #276 merged)
2. Bumped `package.json` version: `1.14.12` → `1.14.13-dev.1`
3. Added changelog entries to `README.md` and `README.zh-CN.md`
4. Created devlog

## Verification

- CI will run on PR creation (5 checks: pr-validation, test 22/24, build, e2e)
- Version contains `-` → CI publishes to `dev` npm tag as prerelease
