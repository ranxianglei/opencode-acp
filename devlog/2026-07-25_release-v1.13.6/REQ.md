# REQ — v1.13.6 Release

## Goal

Publish v1.13.6 to npm `latest` via the automated release workflow. This release
ships PR #188 (force-protect `compress` tool regardless of user config).

## Background

PR #188 was merged to master (commit `9670543`) but the release CI only auto-runs
when a `YYYY-MM-DD_release-v*` branch is merged. A release PR is required to
trigger tag + npm publish + GitHub Release.

## Scope

- Bump `package.json` version 1.13.5 → 1.13.6
- Add changelog entry to `README.md` and `README.zh-CN.md`
- Create devlog entry
- Verify (typecheck + tests + build + CI check script)
- Commit, push, create PR
- Human merges the PR → CI auto-publishes

## Out of Scope

- No source code changes (only version bump + docs + devlog)
- No config schema changes

## Acceptance Criteria

- [x] Version bumped to 1.13.6
- [x] Changelog entries added to both READMEs
- [x] Devlog created
- [ ] `./scripts/ci/check-pr.sh` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (846 tests)
- [ ] PR created on GitHub
