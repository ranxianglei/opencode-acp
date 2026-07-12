# WORKLOG

## Branch: `2026-07-12_release-v1.12.1`
## Base: `master` (commit `1d0f236` — PR #119 merge)

### Steps
1. Created branch `2026-07-12_release-v1.12.1` from master
2. Bumped `package.json`: 1.12.0 → 1.12.1
3. Added changelog entry to `README.md`
4. Added changelog entry to `README.zh-CN.md`
5. Created devlog `devlog/2026-07-12_release-v1.12.1/`

### CI
On merge → `release.yml` detects `YYYY-MM-DD_release-v*` branch → auto-tags `v1.12.1` → builds → tests → publishes to npm → creates GitHub Release.
