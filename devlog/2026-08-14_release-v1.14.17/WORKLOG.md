# WORKLOG — v1.14.17: Stable release of master (per-PR npm preview builds)

## Investigation

- `git log v1.14.16..master`: one substantive commit since v1.14.16 —
  #298 (`0c59851`): new `pr-artifact.yml` (per-PR npm publish under
  `pr-<N>` tag, tarball + dist/ artifact upload, PR install-instructions
  comment) + `release.yml` published-version comment + one package.json
  line. CI/workflow-only; no runtime changes.
- #299 (`8a2bee3`) merged with ONLY its devlog files — the workflow change
  its WORKLOG describes (`GITHUB_OUTPUT` version display in pr-artifact.yml)
  is NOT on master (verified by grep). Changelog credits #298 only.
- Prior release PR (#304, closed) incorrectly carried the #301 fix commits
  on the release branch. AGENTS.md convention (verified against
  v1.14.8–v1.14.16): release commits contain only the 5 release files;
  feature code reaches master through its own PRs before the release branch
  is cut.

## Change

Release files only:

- `package.json`: 1.14.16 → 1.14.17.
- `README.md` / `README.zh-CN.md`: v1.14.17 changelog entries (#298).
- `devlog/2026-08-14_release-v1.14.17/REQ.md` + `WORKLOG.md` (this pair).

Branch reset to `github/master` (`8a2bee3`) — code identical to master.

## Verification

- typecheck (`tsc --noEmit`): clean.
- tests: 976 pass / 0 fail.
- `./scripts/ci/check-pr.sh 2026-08-14_release-v1.14.17 github/master`: all
  checks passed.

## Release

- Commit `release: v1.14.17 — CI dist artifact + npm version display`.
- Merge (human) triggers release.yml → tag `v1.14.17` → npm `latest` →
  GitHub Release.
- #302/#303 (#301 fixes) merge AFTER this release and ship in a later
  version.
