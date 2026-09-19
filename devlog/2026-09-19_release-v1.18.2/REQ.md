# REQ - Release v1.18.2 (patch)

- Task ID: `2026-09-19_release-v1.18.2`
- Home Repo: `opencode-acp`
- Created: 2026-09-19
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/400 (floor 12, "发新版本")

## Scope

Bump `package.json` 1.18.1 → 1.18.2 and ship everything merged to master since v1.18.1:

| PR / commit | Content | Issue |
|-------------|---------|-------|
| #432 | Strip leaked bare ACP refs from completed assistant text — new pure function `stripLeakedTrailingRefs()` in `lib/messages/utils.ts`, applied by the `text.complete` handler in `lib/hooks.ts`; +222-line test suite `tests/leaked-trailing-ref.test.ts`, review-nit tests, cast-free bounds-narrowing refactor | fixes #431 |
| #403 | Normalize single Windows path separators in `protectedFilePatterns` (`lib/protected-patterns.ts` one-character fix; +104 tests) | fixes #402 |
| c6066c4b (CI) | `.github/workflows/publish-stable-from-acp.yml` — publishes the separate `opencode-stable` CLI fork; CI-only, no runtime code | — |
| #433 | promote-stable devlog only (side effect already executed: npm `stable` = 1.18.1) | — |

Both runtime changes are bug fixes → semver PATCH: **v1.18.2**.

## Changes in this branch

1. `package.json`: `version` 1.18.1 → 1.18.2
2. `CHANGELOG.md`: new `### v1.18.2` entry at top
3. `CHANGELOG.zh-CN.md`: new `### v1.18.2` entry at top
4. This devlog folder (`REQ.md` + `WORKLOG.md`)

No other code changes. Branch name `YYYY-MM-DD_release-v{VERSION}` + human merge triggers `release.yml`: auto-tag `v1.18.2` → build → test → npm publish to `latest` → GitHub Release.

## Verification plan

- `./scripts/ci/check-pr.sh 2026-09-19_release-v1.18.2 origin/master` (changelog check active this time because version changed)
- `npm run typecheck`, `npm run build`, `npm run test`
- After human merge: verify `npm view opencode-acp dist-tags.latest` = 1.18.2 and the GitHub Release exists.
