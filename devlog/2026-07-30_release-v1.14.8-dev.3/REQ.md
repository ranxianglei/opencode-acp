# REQ: Dev Prerelease v1.14.8-dev.3

## Requirement

Publish a dev prerelease (`dev` npm tag) to include PR #248 (tool pair integrity fix) since v1.14.8-dev.2.

## Scope

- Bump version to `1.14.8-dev.3`
- Add changelog entries to `README.md` and `README.zh-CN.md`
- Create devlog entry
- CI auto-publishes with `--tag dev` (version contains `-`)

## PRs Included

- **#248** — Fix: auto-extend compression ranges to prevent splitting tool_use/tool_result pairs (Issue #247)

## Out of Scope

- No source code changes (release-only)
- Stable release (v1.14.8) deferred until dev testing confirms
