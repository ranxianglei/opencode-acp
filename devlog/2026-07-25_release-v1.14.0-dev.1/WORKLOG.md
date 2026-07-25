# WORKLOG - Release v1.14.0-dev.1

- Task ID: `2026-07-25_release-v1.14.0-dev.1`
- Branch: `2026-07-25_release-v1.14.0-dev.1` (base: `2026-07-24_per-session-state`)
- Started: 2026-07-25

## Steps

- [x] Created worktree at `/tmp/opencode-release-dev` from `2026-07-24_per-session-state` (which merges github/master v1.13.5)
- [x] Created release branch `2026-07-25_release-v1.14.0-dev.1`
- [x] Bumped version: `1.13.5` → `1.14.0-dev.1` in `package.json`
- [x] Added changelog entry to `README.md` (English)
- [x] Added changelog entry to `README.zh-CN.md` (Chinese)
- [x] Created devlog entry (`REQ.md` + `WORKLOG.md`)
- [ ] Run `check-pr.sh` to verify CI compliance
- [ ] `npm install` + `npm run build` + `npm test` in worktree
- [ ] Commit, push to github, create PR
- [ ] Human merges PR → CI auto-publishes to npm `dev` tag

## Verification

- Version: `1.14.0-dev.1` (contains `-` → CI detects as prerelease → `--tag dev`)
- 848 tests pass (verified on base branch `2026-07-24_per-session-state`)
