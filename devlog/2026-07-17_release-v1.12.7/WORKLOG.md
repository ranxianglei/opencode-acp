# WORKLOG: Release v1.12.7 (stable)

## Steps

1. Created branch `2026-07-17_release-v1.12.7` from `github/master` @ `895fcd6` (post-PR #150 merge).
2. Bumped `package.json` version: `1.12.7-dev.1` → `1.12.7`.
3. Replaced `v1.12.7-dev.1` changelog entry in `README.md` and `README.zh-CN.md` with stable `v1.12.7` entry covering all 4 PRs (#142, #147, #149, #150).
4. Created devlog entry (`REQ.md` + this `WORKLOG.md`).
5. Verified: `npm run typecheck` 0 errors, `npm test` 725/725 pass, `npm run build` clean.
6. Created PR; await CI + human merge.
7. On merge: CI `release.yml` auto-tags `v1.12.7`, publishes to npm `latest`, creates GitHub Release.

## Verification

- TypeScript: 0 errors
- Tests: 725/725 pass (Node v25.9.0)
- Build: clean

## Post-merge

CI fully automated — no manual `npm publish` needed.
