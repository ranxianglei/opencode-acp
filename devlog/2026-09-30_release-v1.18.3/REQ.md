# REQ - Release v1.18.3 (patch)

- Task ID: `2026-09-30_release-v1.18.3`
- Home Repo: `opencode-acp`
- Created: 2026-09-30
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/pull/475 (one-click release fallback PR)

## Scope

Bump `package.json` 1.18.2 → 1.18.3 and ship everything merged to master since v1.18.2:

| PR / commit | Content | Issue |
|-------------|---------|-------|
| #406 | Yield to billion-context native mode via action-time env re-check (`index.ts`, `lib/bili-proxy.ts`, `lib/compress/types.ts`); includes dual-agent review follow-ups | fixes #405 |
| #447 | Keep quality-gate rejection concise — strip internal details from model-facing error, log full diagnostics (`lib/compress/quality-gate/rejection.ts`, `lib/compress/range.ts`) | fixes #444 |
| #449 | Verify source-message availability before committing decompression (`lib/compress/decompress-logic.ts`, `lib/compress/decompress.ts`) | fixes #446 |
| #448 | `decompress.toFile` exports serialized original messages, not JSON garbage (`lib/compress/decompress.ts`) | — |
| #466 | Never override explicit/wildcard user decisions on `acp_status` in host config write (`lib/host-permissions.ts`, `index.ts`) | fixes #457, #465 |
| #473 | Bound `overheadErrorLogged` Set in truncate-tools (cap 1024, oldest-first eviction) | fixes #461 |
| #443 | One-click release workflow (`release-manual.yml`, `workflow_dispatch`) + devlog | — |
| #474 | One-click release heals package-lock.json version drift instead of failing | — |
| #441 | README: point OpenCode 2.x users to billion-context | — |
| #471 | AGENTS.md: codify OpenCode V2 → billion-context migration + triage rule; stale version table fix; stray-space nit | refs #442 |
| #450/#451 | README(±zh): new QQ group 1108730198 added, original 1056132097 marked full; Community section moved to top | — |

All runtime changes are bug fixes → semver PATCH: **v1.18.3**.

## Changes in this branch

1. `package.json`: `version` 1.18.2 → 1.18.3 (done by the one-click workflow)
2. `package-lock.json`: synced (done by the one-click workflow)
3. `CHANGELOG.md`: new `### v1.18.3` entry at top (added in review fix-up — see WORKLOG step 2)
4. `CHANGELOG.zh-CN.md`: new `### v1.18.3` entry at top (same reason)
5. This devlog folder (`REQ.md` + `WORKLOG.md`) (same reason)

No other code changes. Merging this PR triggers `release.yml`: auto-tag `v1.18.3` → build → test → npm publish to `latest` → GitHub Release.

## Verification plan

- `./scripts/ci/check-pr.sh 2026-09-30_release-v1.18.3 origin/master` — must pass all checks (it failed 3 before the fix-up commit; see WORKLOG)
- Version-range regression audit v1.18.2..HEAD performed during PR #475 review (see WORKLOG "Audit")
- After human merge: verify `npm view opencode-acp dist-tags.latest` = 1.18.3 and the GitHub Release exists
