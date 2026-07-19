# WORKLOG: v1.12.11 Release

## 2026-07-19

### Release preparation

- Branch `2026-07-19_release-v1.12.11` created from `github/master` @ `5f949bb`
  (post PR #164 squash merge)
- `package.json`: `1.12.10` → `1.12.11`
- `README.md`: Added `### v1.12.11 — README Refresh (PR #164)` changelog entry
  describing the 6 documentation updates
- `README.zh-CN.md`: Added matching `### v1.12.11 — README 文档刷新（PR #164）`
  entry
- devlog/2026-07-19_release-v1.12.11/REQ.md + WORKLOG.md created

### What's bundled

- PR #164 (squash-merged as `5f949bb`): README context statistics refresh +
  tagline + GC safety net section + cache stats + protected tools default

### Verification

- typecheck: 0 errors
- tests: 768/768 pass (no code changes, same as v1.12.10)
- No build needed (docs-only release, but build still passes)

### Release steps remaining

1. Commit changes
2. Push branch
3. Create PR titled `release: v1.12.11 — README Refresh`
4. Await user merge
5. CI auto-publishes to npm `latest` (force=true fallback if squash-merge
   detection fails, as with v1.12.10)
