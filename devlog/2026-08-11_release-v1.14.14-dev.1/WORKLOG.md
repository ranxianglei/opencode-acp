# WORKLOG — v1.14.14-dev.1 (Dev Prerelease)

## Changes

- Bumped `package.json` version `1.14.13` → `1.14.14-dev.1`.
- Added `### v1.14.14-dev.1` changelog entry to `README.md` (EN) and
  `README.zh-CN.md` (ZH), covering PRs #288 and #290.
- Created devlog entry (this folder).

## Verification

- `scripts/ci/check-pr.sh 2026-08-11_release-v1.14.14-dev.1 github/master` — pass.
- `npm run typecheck` — 0 errors.
- `npm run build` — dist/index.js success.

## Publish path

CI `release.yml` detects the version contains `-` → publishes with
`--tag dev` and marks the GitHub Release as `prerelease: true`. Users install
via `opencode plugin opencode-acp@dev --global`.
