# REQ — v1.14.20: Post-v1.14.19 fix batch (modelContextLimit lifecycle, inactive-block decompress, logging)

## Problem

Five clusters of issues reported since v1.14.19:

1. **`modelContextLimit` stays stale after model switch (#312, #315).** Within one LLM request the messages hook runs before the system hook refreshes the limit, and on a catalog miss (fresh instance + failed hydration) the previous model's window survived — every percentage-based threshold misfired.
2. **`decompress` fails on standalone inactive blocks (#193).** A block that became inactive (superseded by a higher-tier compress) could no longer be restored: `Block not found`. Inactive blocks were also invisible in `acp_status`.
3. **Preemptive `acknowledgeRisk: true` errors (#301, #303).** Carrying `acknowledgeRisk: true` from a non-quality error hard-failed with `no quality gate rejection is pending`.
4. **Debug nudge phantom turn loop (#311, #278).** Debug notification used `sendIgnoredMessage`, creating a phantom assistant turn on every nudge.
5. **Log spam + missing errors (#279, #311).** The debug recommendation-filter log fired every turn; ERROR/WARN lines only reached the daily log when debug was enabled.

## Fix

- **#314 + #315**: reconcile `state.modelContextLimit` from the model-limit catalog on model switch; record the (provider, model) identity pair alongside the limit and, on a catalog miss, invalidate it when the request's model identity mismatches (match keeps it; legacy persisted states without an identity are treated as stale — one blind turn per upgraded session). Catalog extracted to `lib/state/model-limits.ts`; failed hydration now logs (info with entry count on success, warn on zero/failure) instead of degrading silently.
- **#193**: `decompress` accepts standalone inactive blocks (nested-block redirect unchanged); `acp_status scope=compressed` now lists all blocks with an `[inactive]` marker plus active/inactive counts (overview still shows active only).
- **#303**: `acknowledgeRisk` without a pending quality-gate rejection is a no-op with a usage-teaching note; only a real quality-gate rejection arms the bypass.
- **#278/#279/#311**: debug notifications no longer use `sendIgnoredMessage`; the recommendation-filter log is gated behind `shouldInject`; ERROR/WARN are written to the daily log even when debug is off.

## Acceptance

- All existing tests pass (1003)
- Release commit touches only `package.json` + lock; changelog + devlog on the release branch
- `./scripts/ci/check-pr.sh` green
- release.yml publishes v1.14.20 to npm `latest` after merge
