# WORKLOG: Dev Prerelease v1.14.8-dev.1

## 2026-07-30

### Release prep
- Created worktree `/tmp/opencode-acp-release-v1.14.8-dev` on branch `2026-07-30_release-v1.14.8-dev` from master (`f842e3f`)
- Bumped version: `1.14.7` → `1.14.8-dev.1`
- Added changelog entries to `README.md` and `README.zh-CN.md`
- Created devlog

### Verification
- npm view: latest=1.14.7, dev=1.13.9-dev.1 (stale — this release updates dev to current master)

### Pending
- Run CI checks locally
- Commit, push, create PR
- Human merges PR → CI auto-publishes to `dev` npm tag
