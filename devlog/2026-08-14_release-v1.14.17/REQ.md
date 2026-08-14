# REQ — v1.14.17: Stable release of master (per-PR npm preview builds)

## Background

One substantive change merged to master since v1.14.16 and is unreleased:

- #298 (`0c59851`) — new `.github/workflows/pr-artifact.yml`: every PR to
  master builds the plugin, publishes it to npm under a `pr-<N>` tag
  (version `<base>-pr.<N>.<run>`), uploads the tarball + `dist/` as a
  workflow artifact (30-day retention), and comments install instructions
  on the PR. `release.yml` also comments the published version on the
  associated PR after a release merge. `package.json` gained one line
  (npm publish config).

Note on #299 (`8a2bee3`): its merge commit contains ONLY devlog files. The
workflow change its WORKLOG describes (`pr-artifact.yml` `GITHUB_OUTPUT`
version display) is NOT on master — the code change was lost before merge.
This release therefore credits #298 only; #299's functionality needs a
follow-up PR if still wanted.

The pending #301 fix PRs (#302, #303) are intentionally NOT part of this
release; they merge after and ship in a later version.

## Requirement

Cut a stable release from current master (`8a2bee3`) per AGENTS.md §5.4.2:
branch `2026-08-14_release-v1.14.17`, version 1.14.16 → 1.14.17, bilingual
changelog describing #298 accurately, release commit containing ONLY the 5
release files.

## Acceptance criteria

- `./scripts/ci/check-pr.sh 2026-08-14_release-v1.14.17 github/master` passes.
- typecheck + tests green (code identical to master).
- Merge triggers release.yml: tag `v1.14.17`, npm publish `latest`,
  GitHub Release.
