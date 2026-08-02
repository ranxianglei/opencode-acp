# WORKLOG: Release v1.14.9-dev.1

## Steps

1. Created worktree `/tmp/opencode-acp-release-v1.14.9-dev.1` on branch `2026-08-02_release-v1.14.9-dev.1`
2. Linked node_modules from main repo
3. Bumped `package.json` version: `1.14.8-dev.5` → `1.14.9-dev.1`
4. Added changelog entry to `README.md` (1 PR: #259)
5. Added changelog entry to `README.zh-CN.md` (1 PR: #259)
6. Created devlog entry

## Verification

- Dev prerelease version (has `-` suffix) → CI publishes to `dev` tag
- 1 PR since v1.14.8-dev.5: #259 (multi-entry compress docs)
