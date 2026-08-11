# REQ — v1.14.14 (Stable Release)

## Goal

Publish the stable release `1.14.14` to the npm `latest` tag covering the two
compress-subsystem fixes merged to `master` since v1.14.13.

## PRs included (since v1.14.13)

1. **#288** (via #289) — `hideConsumedCompressCalls` per-block hide-consumed to
   stop summary leak in batched compress calls.
2. **#290** (via #291) — Partial-failure batch compress + phantom diagnostics +
   clamp warning.

## Version rationale

Patch bump (1.14.13 → 1.14.14). Both PRs are compress-subsystem fixes; the
project cadence is patch-level for fix releases.

## Note on branch base

This branch is rebased onto the post-dev-merge `master` (e6fbdf2, which contains
the squashed v1.14.14-dev.1). It adds only the stable-specific delta: version
bump to `1.14.14`, the `### v1.14.14` changelog entries, and this devlog.

## Acceptance criteria

- [x] `package.json` version = `1.14.14`.
- [x] `README.md` + `README.zh-CN.md` changelog entries under `### v1.14.14`.
- [x] `scripts/ci/check-pr.sh` passes.
- [x] `npm run build` + `npm run typecheck` pass.
- [x] PR mergeable (no conflicts); on merge CI publishes to `latest` tag.
