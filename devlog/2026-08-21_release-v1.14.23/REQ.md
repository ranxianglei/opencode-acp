# REQ — v1.14.23: fix batch (#325, #326, #327, #328)

## Problem

Patch release shipping four fix clusters accumulated on master since v1.14.22:

1. **#325** (issue #37 phantom loop): nudge accounting counted pipeline-soft-filtered messages
   as compressible → phantom-range recommendations → ~10 failed retries re-arming the same nudge.
2. **#326** (#216 residual): emergency override + `nothingToCompress` still demanded "compress
   now" every turn (~12 failed compressions in incident `ses_7fb5cbc8`).
3. **#327**: `nudgeGrowthTokens` adaptive default (`window×5%`) scaled nudge cadence 5× between
   262K/1M models with identical config; config-default vs policy-default divergence since
   v1.14.15.
4. **#328**: auto-update never fired for `@stable` installs (dist-tag gate) and compared against
   hardcoded `latest` — unlandable for tagged installs.

## Content since v1.14.22

- `a6921bd` Merge PR #325 — `fix: effective compressible accounting stops phantom-range retry loops`
- `e9a6b08` Merge PR #326 — `fix: emergency + nothing-to-compress emits /compact notice (#216 residual)`
- `c2c863b` Merge PR #327 — `fix: nudgeGrowthTokens fixed default 50K — removes window-percentage scaling`
- `971d9b7` Merge PR #330 — `fix: auto-update tracks installed dist-tag, not hardcoded latest (#328)`

## Acceptance

- All existing tests pass (1024 expected)
- Version bump on this release branch only; `CHANGELOG.md` and `CHANGELOG.zh-CN.md` updated
  with `### v1.14.23`
- typecheck green
- release.yml publishes v1.14.23 to npm `latest` after merge
