# WORKLOG — v1.14.20

## Commits on this release (8 fix commits since v1.14.19)

1. `df0b194` promote: stable v1.14.19 devlog paperwork
2. `49560d9` fix: write ERROR/WARN to daily log even when debug off (#311)
3. `48b941e` fix: reconcile modelContextLimit on model switch (#312/#314)
4. `bb24e83` review(#314): log hydration outcome + dedupe model-limit catalog (extracted `lib/state/model-limits.ts` `createModelLimitCatalog`)
5. `9abff6f` fix: gate debug recommendation filter log behind shouldInject (#279)
6. `38a1920` fix: debug nudge phantom turn loop — stop sendIgnoredMessage (#278)
7. `2761605` fix(compress): preemptive acknowledgeRisk no-op (#301/#303)
8. `73312f4` fix: inactive block decompress + acp_status visibility (#193)
9. `0a63a10` fix(#312): invalidate stale modelContextLimit on catalog miss (#315)

## Release steps

- Preflight: `npm ci` + typecheck + build + test — 1003 tests pass (`/tmp/preflight-opencode-acp.log`)
- `npm version 1.14.20 --no-git-tag-version` (bump commit on release branch)
- Changelog `### v1.14.20` entries added to `README.md` and `README.zh-CN.md`
- Devlog: this folder (REQ.md + WORKLOG.md)
- Commit `release: v1.14.20 — post-v1.14.19 fix batch (modelContextLimit, inactive-block decompress, logging)`

## Verification

- `./scripts/ci/check-pr.sh 2026-08-17_release-v1.14.20 origin/master` — green
- release.yml publishes v1.14.20 to npm `latest` after merge
