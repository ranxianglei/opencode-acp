# WORKLOG: README + Changelog for v1.10.0

## Changes

### README.md

- Added v1.10.0 changelog entry describing the hard-exclusion fix (issue #16, PR #75)
- Updated "Protected Tools" section: "appended to the compressed summary" → "hard-excluded from compression ranges"
- Bumped bug count 38 → 39, added Bug 39 row

### README.zh-CN.md

- Added v1.10.0 changelog entry (Chinese translation)
- Updated "受保护工具" section: "附加到压缩摘要中" → "硬排除在压缩范围之外"
- Bumped bug count 37 → 39 (Chinese README was behind by bug 38)
- Added Bug 38 and Bug 39 rows

### devlog

- Created devlog/2026-07-08_readme-changelog-1.10.0/ with REQ.md + WORKLOG.md

## Verification

- `git diff --stat` confirms only README.md and README.zh-CN.md changed (2 files, +41 -4)
- No code changes, no test changes, no config changes
