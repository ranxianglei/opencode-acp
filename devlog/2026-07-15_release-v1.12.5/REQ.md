# REQ: Release v1.12.5

## Summary

Patch release bundling two bug fixes merged after v1.12.4:

- **PR #139** — Bug 20 suppression format mismatch fix
- **PR #140** — Growth floor gate correction (`nudgeAllowed` requires `decision.shouldNudge`)

## Motivation

v1.12.4 introduced the growth floor gate (PR #134) but had two regressions:

1. The Bug 20 suppression in `isContextOverLimits` used a non-existent SDK part format (`tool-invocation` / `toolInvocation`), so `overMaxLimit` was never suppressed after a compress call → over-compression feedback loop.
2. The growth floor gate made `growthFloor` the sole condition for `nudgeAllowed`, dropping the `decision.shouldNudge` requirement.

Both are fixed on master. This release ships them to npm.

## Changes

- `package.json`: version `1.12.4` → `1.12.5`
- `README.md` / `README.zh-CN.md`: changelog entries for v1.12.5

## Verification

- CI check (`scripts/ci/check-pr.sh`) must pass
- No code changes — release-only PR
