# REQ: v1.12.11 Release

## Goal

Publish a stable patch release `v1.12.11` to npm `latest`, bundling the README
documentation refresh from PR #164.

## Background

PR #164 (branch `2026-07-19_readme-context-data`) was squash-merged to master
as commit `5f949bb`. It contained two rounds of README updates:

1. Refreshed "Proven at scale" table with real API-level data from 6 active
   sessions (Duration, Messages, API calls, Cumulative tokens, Cache hit %,
   P50/P90/P95).
2. Added "200K tokens is enough" tagline, replaced outdated "Deletion strategy"
   section with "GC safety net", updated cache stats (87% → 91%, context ~30%
   → ~10–15%), corrected `compress.protectedTools` default to `skill` only.

No code changes — pure documentation release. Tests unchanged at 768.

## Scope

- Bump `package.json` version: `1.12.10` → `1.12.11`
- Add `### v1.12.11` changelog entries to `README.md` and `README.zh-CN.md`
- Create this devlog entry
- Verify: typecheck, 768 tests pass, build
- Push branch, create PR, await user merge

## Out of Scope

- Any code changes
- Any new features
- Behavior changes

## Acceptance Criteria

- [x] `package.json` version = `1.12.11`
- [x] Both READMEs have `### v1.12.11` entry at the top of the changelog
- [x] devlog/2026-07-19_release-v1.12.11/ has REQ.md + WORKLOG.md
- [x] `npm run typecheck` passes
- [x] `npm run test` — 768/768 pass
- [x] PR created with `release: v1.12.11` title
- [ ] User merges PR → CI auto-publishes to npm `latest`
- [ ] `npm view opencode-acp version` returns `1.12.11`
