# REQ: Release v1.13.8-dev.1

## Goal

Sync the npm `dev` tag with v1.13.7 stable. Content is identical to v1.13.7 — no new code changes.

## Version

- Current: `1.13.7`
- Target: `1.13.8-dev.1` (dev prerelease, npm `dev` tag)

## Scope

Version bump + changelog entries. No source code changes.

## Acceptance Criteria

- [x] `package.json` version bumped to `1.13.8-dev.1`
- [x] Changelog entries added to `README.md` and `README.zh-CN.md` with `### v1.13.8-dev.1` header
- [x] Devlog created
- [x] typecheck + tests + build pass
- [x] PR created

## Note

This PR depends on #197 (v1.13.7 stable) being merged first. If #197 is still open when this is reviewed, the diff will include v1.13.7 changes as well. Merge #197 first, then rebase this PR on master before merging.
