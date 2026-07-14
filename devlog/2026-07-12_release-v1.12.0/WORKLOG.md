# WORKLOG

## Branch: `2026-07-12_release-v1.12.0`

### Steps

1. Created release branch from `2026-07-11_compress-keep-ranges` (includes all PR #115 changes)
2. Bumped `package.json` version: 1.11.4 → 1.12.0
3. Added changelog entries to `README.md` and `README.zh-CN.md`
4. Created devlog entry
5. Committed, pushed, created PR

### Contents

All 7 commits from `2026-07-11_compress-keep-ranges`:

- `1e4a92d` feat: KEEP/REF markers + compressible ranges listing
- `5bca817` fix: add KEEP anti-pattern guidance to compress prompt
- `3d9c801` fix: move KEEP anti-pattern guidance to HOW TO COMPRESS rules
- `169e720` fix: compress detection overwrites disk baseline on restart
- `3a4ed2c` fix: notification summary empty for multi-block compressions
- `3f5bfbe` feat: inject nudge text to terminal when debug mode is on
- `3d3def4` fix: baseline leak after compress + Oracle review fixes

### Verification

- 630 tests pass
- typecheck OK
- Oracle reviewed
