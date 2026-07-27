# WORKLOG — release v1.14.4

## Steps

1. Created worktree `/tmp/opencode-acp-release-v1.14.4` from `github/master` (`6042020`).
2. Confirmed unreleased commits since v1.14.3 (`00e8ba5`):
   - `618c290` PR #215 — tier detection fix
   - `9da4e4e` PR #214 — E2E test fix
   - `f61e42b` PR #217 — debug chat notification
   - `6042020` PR #218 — nudge injection loop fix
3. Bumped `package.json` version `1.14.3 → 1.14.4`.
4. Added changelog entries to `README.md` and `README.zh-CN.md` covering all 4 PRs.
5. Created devlog `devlog/2026-07-27_release-v1.14.4/{REQ,WORKLOG}.md`.
6. Verified: typecheck 0 errors, 936 tests pass, build succeeds.
7. Ran `./scripts/ci/check-pr.sh` — all checks pass.
8. Committed, pushed, created PR.

## Verification

- `npm run typecheck` — 0 errors
- `npm run test` — 936/936 pass
- `npm run build` — succeeds, `1.14.4` substituted in dist via ACP_VERSION define
- `./scripts/ci/check-pr.sh 2026-07-27_release-v1.14.4 origin/master` — all pass

## Post-Merge

CI `release.yml` auto-detects release branch merge, creates `v1.14.4` tag, builds, tests, publishes to npm `latest`, creates GitHub Release.
