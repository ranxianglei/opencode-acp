# WORKLOG — v1.14.21

## Commits on this release (1 fix commit since v1.14.20)

1. `c230d6e` fix: /acp commands work regardless of compress permission + wire up export + help (#286)
   - squash of the #286 PR (permission gate removal + `/acp export` + bare `/acp`→stats + `/acp help`)
   - rebase follow-up: restored `sendIgnoredMessage` import after rebasing onto post-#278 master (v1.14.20)

## Release steps

- `npm version 1.14.21 --no-git-tag-version` (bump `package.json` + `package-lock.json`)
- Changelog `### v1.14.21` entries added to `README.md` and `README.zh-CN.md`
- Devlog: this folder (REQ.md + WORKLOG.md)
- Commit `release: v1.14.21 — /acp command fixes and completion (permission gate, export, help)`

## Verification

- `npm test` — full suite green (see run below)
- `./scripts/ci/check-pr.sh 2026-08-17_release-v1.14.21 origin/master` — green
- release.yml publishes v1.14.21 to npm `latest` after merge
