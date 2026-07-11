# REQ - AGENTS.md CI Documentation Update

- Task ID: `2026-07-11_ci-docs`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background

AGENTS.md Section 5.4 still described the old manual `npm publish` workflow. CI enforcement (pr-checks.yml + release.yml) was added in PR #104 but not documented.

## 2. Acceptance Criteria

- [x] Section 5.4 rewritten to document automated release workflow
- [x] CI enforcement (pr-checks.yml, release.yml) documented
- [x] Step-by-step release process documented
- [x] Manual publish kept as legacy fallback (Section 5.4.4)
