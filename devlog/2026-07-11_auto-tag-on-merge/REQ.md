# REQ - Auto-Tag on Release Branch Merge

- Task ID: `2026-07-11_auto-tag-on-merge`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background

Current release flow requires manual `git tag` + `git push origin v*` after merging a release PR. This is error-prone (easy to forget) and adds an unnecessary manual step.

## 2. Solution

Add `auto-tag.yml` workflow: on push to master, if the merge commit came from a `YYYY-MM-DD_release-v*` branch, automatically read `package.json` version and push `v{VERSION}` tag. The tag push then triggers `release.yml` for auto-publish.

Only release branches trigger auto-tagging. Normal branches that accidentally change `package.json` version are ignored.

## 3. Acceptance Criteria

- [x] `auto-tag.yml` workflow created
- [x] Only triggers on release branch merges (`YYYY-MM-DD_release-v*`)
- [x] Reads version from `package.json`, creates `v{VERSION}` tag
- [x] Skips if tag already exists
- [x] AGENTS.md Section 5.4 updated with auto-tag documentation
