# WORKLOG: Release v1.12.6

## Steps

1. Created worktree `/tmp/opencode-acp-release-1126` from `github/master` (`1db4732` — PR #143 merge)
2. Branch: `2026-07-15_release-v1.12.6`
3. Bumped `package.json`: `1.12.5` → `1.12.6`
4. Added changelog to `README.md` and `README.zh-CN.md` under Changelog / 更新日志 sections
5. Created devlog (`REQ.md` + this `WORKLOG.md`)
6. Ran CI check (`scripts/ci/check-pr.sh`)
7. Committed, pushed, created PR

## Contents

- PR #143 (stale `contextLimitAnchors` fix): `lib/messages/inject/inject.ts` — added `else` branch clearing stale anchors when `!overMaxLimit`. 3 regression tests in `tests/inject.test.ts`. 691 tests pass.

## Verification

- CI check passes
- Release-only PR (no code changes beyond version bump + changelog)
