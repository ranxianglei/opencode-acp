# REQ — release v1.14.4

## Goal

Publish patch release v1.14.4 bundling 4 PRs merged to master since v1.14.3.

## Included PRs

| PR | Title | Type |
|----|-------|------|
| #215 | fix: tier detection uses boundary kind, not consumedBlockIds | bug fix |
| #214 | test: fix E2E — add protection scenarios + include 05/06 in CI | test infra |
| #217 | feat: inject compression notification into chat when debug is on | feature |
| #218 | fix: nudge injection loop — 3 defects from issue #216 | bug fix |

## Scope

- Bump `package.json` version `1.14.3 → 1.14.4`
- Add changelog entries to `README.md` and `README.zh-CN.md`
- Create devlog entry
- Verify (typecheck + test + build + CI checks)
- Create release PR (human merges)

## Out of Scope

- No code changes — release-only (version bump + docs + devlog)
- No config or persisted-state schema changes
