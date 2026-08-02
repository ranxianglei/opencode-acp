# WORKLOG: Release v1.14.9

## Steps

1. Created worktree `/tmp/opencode-acp-release-v1.14.9` on branch `2026-08-02_release-v1.14.9`
2. Linked node_modules from main repo
3. Bumped `package.json` version: `1.14.8-dev.5` → `1.14.9`
4. Added changelog entry to `README.md` (3 PRs: #252, #257, #259)
5. Added changelog entry to `README.zh-CN.md` (3 PRs: #252, #257, #259)
6. Created devlog entry

## Verification

- Stable version (no `-` suffix) → CI publishes to `latest` tag
- 3 PRs since v1.14.8: #252 (filterRecommendedRanges + nudge loop), #257 (cc-alg 1.3.0), #259 (multi-entry compress docs)
