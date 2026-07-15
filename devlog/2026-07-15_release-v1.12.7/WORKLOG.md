# WORKLOG: Release v1.12.7

## Steps

1. Created release branch `2026-07-15_release-v1.12.7` from master (which already has PR #142 merged)
2. Bumped version: 1.12.6 → 1.12.7 in package.json
3. Added changelog entries to README.md (EN) and README.zh-CN.md (CN)
4. Created devlog REQ.md + WORKLOG.md
5. Committed, pushed, created PR
6. CI will auto-tag v1.12.7 and publish to npm on merge

## Test Status

711/711 pass on feature branch. Release branch only changes version + changelog (no code changes).
