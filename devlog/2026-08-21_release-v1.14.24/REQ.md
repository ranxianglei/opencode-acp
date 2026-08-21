# Release v1.14.24 — default-on decision-level logging

## Request

Ship a new `latest` release containing the default-on logging feature merged in PR #332 (master `b0eefdd`): severity-leveled file logger, new `logLevel` config defaulting to `info`, INFO audit trail on core paths, invalid-level clamp fix.

## Contents since v1.14.23

- #332 `feat: default-on decision-level logging with configurable logLevel`
  - `LogLevel` (debug|info|warn|error|silent) + rank-gated writes; boolean constructor back-compat (false→warn, true→debug)
  - `logLevel` config (default `info`), schema + docs ×4
  - INFO logs: plugin init, per-request transform summary, model switch, nudge inject/suppress, tier triggers, auto-update lifecycle
  - fix commit `bada84f`: invalid logLevel clamps to legacy mapping (validation is warn-only); info()/debug() skip stack capture when gated
  - tests: 1029 pass locally (was 1024 + 5 logger tests)

## Release checklist

- [x] branch `2026-08-21_release-v1.14.24` from origin/master `b0eefdd`
- [x] `npm version 1.14.24 --no-git-tag-version`
- [x] CHANGELOG.md + CHANGELOG.zh-CN.md v1.14.24 entries
- [x] tsc --noEmit clean; full test suite pass
- [x] PR → CI green → merge (release.yml tags v1.14.24, publishes npm latest, GitHub Release)
- [x] verify `npm dist-tag latest` = 1.14.24
