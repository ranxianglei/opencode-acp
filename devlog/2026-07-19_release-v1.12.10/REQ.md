# REQ: Release v1.12.10

## Summary

Stable release bundling all work merged since v1.12.9 (last stable). Contains 7 PRs across 2 categories: new features and fixes.

## PRs Included

| PR | Type | Description |
|----|------|-------------|
| #73 | feat | Decompress range mode (startId/endId) |
| #155 | fix | Classify compress summary as summaryTokens |
| #156 | feat | Batch compress with per-entry topics |
| #157 | fix | Protected label only shows triggering tools |
| #158 | fix | Suppress nudge when allProtected (superseded by #159) |
| #159 | fix | Discrete 5% check intervals when nudge suppressed |
| #161 | fix | Disable GC memory loss (oversized truncation + age deactivation) |

## Version

`1.12.10-dev.1` → `1.12.10` (patch bump, matching the dev prerelease base)

## Acceptance Criteria

- [x] package.json version = 1.12.10
- [x] README.md changelog has v1.12.10 entry
- [x] README.zh-CN.md changelog has v1.12.10 entry
- [x] Devlog created
- [x] All tests pass (768/768)
- [x] TypeScript clean
