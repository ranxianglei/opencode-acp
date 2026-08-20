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
