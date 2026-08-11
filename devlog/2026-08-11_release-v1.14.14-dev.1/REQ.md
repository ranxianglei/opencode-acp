# REQ — v1.14.14-dev.1 (Dev Prerelease)

## Goal

Publish a dev prerelease (`1.14.14-dev.1`) to the npm `dev` tag covering the two
compress-subsystem fixes merged to `master` since v1.14.13, so users can opt in
to early testing via `opencode-acp@dev`.

## PRs included (since v1.14.13)

1. **#288** (via #289) — `hideConsumedCompressCalls` per-block hide-consumed to
   stop summary leak in batched compress calls.
2. **#290** (via #291) — Partial-failure batch compress + phantom diagnostics +
   clamp warning.

## Version rationale

Patch bump (1.14.13 → 1.14.14). Both PRs are compress-subsystem fixes; the
project cadence is patch-level for fix releases. Dev suffix `-dev.1` per
§5.4.5.

## Acceptance criteria

- [x] `package.json` version = `1.14.14-dev.1`.
- [x] `README.md` + `README.zh-CN.md` changelog entries added under
      `### v1.14.14-dev.1`.
- [x] `scripts/ci/check-pr.sh` passes (branch name, devlog, changelog).
- [x] `npm run build` passes; `npm run typecheck` clean.
- [x] PR created; on merge CI publishes to `dev` tag + prerelease GitHub Release
      (version contains `-`).

## Out of scope

- Stable (`latest`) release — separate release PR (`1.14.14`).
