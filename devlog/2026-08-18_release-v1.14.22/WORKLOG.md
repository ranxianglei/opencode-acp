# WORKLOG — v1.14.22

## Commits on this release (since v1.14.21)

1. `d24b175` Merge pull request #322 — `fix: stabilize system prompt token estimate (#255)`
   - write-if-undefined guard in `cacheSystemPromptTokens` (`lib/ui/utils.ts`)
   - `estimateContextComposition` (`lib/messages/inject/utils.ts`) prefers `state.systemPromptTokens`
   - `collectVisibleMessages` (`lib/compress/status.ts`) prefers the same cache
   - regression tests + §5.7 multi-turn growth-cycle test + E2E `nudgeSystemTokensStable` verifier
2. `0a364e1` Merge pull request #320 — changelog moved to `CHANGELOG.md` / `CHANGELOG.zh-CN.md` (repo-only)

## Release steps

- `npm version 1.14.22 --no-git-tag-version` (bump `package.json` + `package-lock.json`)
- `### v1.14.22` entries added to `CHANGELOG.md` and `CHANGELOG.zh-CN.md`
- Devlog: this folder (REQ.md + WORKLOG.md)
- Commit `release: v1.14.22 — stable system prompt token estimate (#255)`

## Verification

- `npm run typecheck` — green
- `node --import tsx --test tests/*.test.ts` — 1010 pass, 0 fail
- `./scripts/ci/check-pr.sh 2026-08-18_release-v1.14.22 origin/master` — green
- release.yml publishes v1.14.22 to npm `latest` after merge
