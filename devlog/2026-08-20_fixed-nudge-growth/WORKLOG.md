# WORKLOG — Fixed Nudge Growth Threshold

## Changes

- `lib/messages/inject/utils.ts`: removed `resolveAdaptiveNudgeGrowth` wrapper; added
  `DEFAULT_NUDGE_GROWTH_TOKENS = 50_000`
- `lib/messages/inject/inject.ts`: uses fixed default (config override preserved)
- `scripts/e2e/run-e2e.sh`: E2E config sets `nudgeGrowthTokens: 6000` (E2E window 100K previously
  got adaptive 6000; fixed default would change scenario behavior)
- `tests/inject-utils-pure.test.ts`: adaptive tests → fixed-default test
- `tests/inject.test.ts`: floor test now uses explicit config override (6000)
- `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`: default `50000` (fixed), scaling removed
- `README.md` / `README.zh-CN.md`: T2 trigger description updated

## Verification

- typecheck: 0 errors
- Full suite: 1004 pass / 0 fail
- E2E scenarios 06/09/10/11/12: 5/5 pass locally
- Deployed to ~/.cache/opencode/packages/opencode-acp@latest/

## Update: review fixes (Explore findings + CI e2e failure)

- **CI e2e 08-nudge-with-protection failed** (`blockCount 0`): scenario acpConfig REPLACES the
  base config wholesale (write_acp_config override), so its compress object lost the
  nudgeGrowthTokens pin → fixed 50K default → growth never reached it. Previously undefined →
  adaptive(100K)=6000 fired. Fix: scenario 08 compress now pins `nudgeGrowthTokens: 6000`.
  Local: 08 + 06 pass.
- dcp.schema.json toolOutputNudgeThreshold description: dropped stale adaptive formula text.
- CONFIGURATION.{md,zh-CN}.md minNudgeGrowthRatio/minNudgeGrowthFloor: formula corrected to
  `× nudgeGrowthTokens` (was wrongly `× modelContextLimit`).
- inject.ts growthFloor comment: removed window-dependent examples.
- tests/inject.test.ts: 2 stale comments updated.

## Update 2: Oracle review fixes

- dcp.schema.json nudgeGrowthTokens description: removed stale adaptive formula + harmful
  "Must be unset (not 6000)" advice; now documents fixed 50000 default + derived gates.
- lib/state/model-limits.ts: removed "adaptive nudge growth" from the percentage-threshold
  list (no longer window-derived).
- Oracle's scenario 08 finding (threshold 6000→50000 via config-replace semantics) was the
  CI e2e failure root cause — already fixed in previous commit (2906d77).
- Left as-is (LOW): trigger-policy-integration.test.ts still tests the cc-alg policy's
  resolveAdaptiveNudgeGrowth method (dependency API contract, now unwired from inject);
  fixed-default constant test (change-detector, guards accidental drift).
