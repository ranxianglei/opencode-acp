# REQ: Release v1.13.7

## Goal

Ship a new stable release bundling three bug-fix PRs merged since v1.13.7-dev.1:

1. **PR #184** — Per-session `SessionStateRegistry`: fixes subagent state isolation (child sessions overwriting parent's `modelContextLimit`). Also reverts the over-aggressive `baseline = 0` back to `baseline = currentTokens`.
2. **PR #193** — Inactive block fixes: `decompress` no longer rejects inactive standalone blocks; `acp_status` shows all blocks (active + inactive) with markers.
3. **PR #196** — Preserve first user message: replaces `preserve-last-user` with `preserve-first-user` to fix the month-long zero-user session freeze (zhipuai-lb code 1214).

## Version

- Current: `1.13.7-dev.1`
- Target: `1.13.7` (stable, npm `latest` tag)

## Scope

Version bump + changelog entries in `README.md` and `README.zh-CN.md`. No source code changes — all fixes are already on master via their respective PRs.

## Acceptance Criteria

- [x] `package.json` version bumped to `1.13.7`
- [x] Changelog entries added to `README.md` and `README.zh-CN.md` with `### v1.13.7` header
- [x] Devlog `REQ.md` + `WORKLOG.md` created
- [x] `./scripts/ci/check-pr.sh` passes
- [x] typecheck + tests + build pass
- [x] PR created, CI green
