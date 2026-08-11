# WORKLOG — v1.14.14 (Stable Release)

## Changes

- Rebased stable branch onto post-dev-merge master (e6fbdf2) to clear the
  conflict caused by #292 being squash-merged (the original stable branch was
  based on the pre-squash dev commit d46c541, which is not in master history,
  so both branches appeared to add the same changelog lines).
- Bumped `package.json` version `1.14.14-dev.1` → `1.14.14`.
- Added `### v1.14.14 — Stable Release (2 PRs since v1.14.13)` changelog entry
  to `README.md` (EN) and `### v1.14.14 — 正式版` to `README.zh-CN.md` (ZH),
  above the dev entry. Install via `opencode-acp@latest`.
- Recreated devlog entry.

## Verification

- `scripts/ci/check-pr.sh` — pass.
- `npm run typecheck` — 0 errors.
- `npm run build` — success.
- GitHub `mergeable_state` clean after force-push.

## Publish path

CI `release.yml` detects the version does NOT contain `-` → publishes with
`--tag latest` and creates a stable GitHub Release. Users install via
`opencode plugin opencode-acp@latest --global`.
