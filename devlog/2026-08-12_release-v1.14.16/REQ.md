# REQ — v1.14.16: Raise context limit to 80%

## Background

The compression trigger threshold (`compress.maxContextLimit`) defaulted to `55%`.
The strong "over-limit" nudge fired as soon as context exceeded 55% of the model
window. Even after pinning the nudge growth to a fixed 50K (v1.14.15), compression
still engaged relatively early, leaving usable context unused.

## Requirement

Raise the default `compress.maxContextLimit` from `"55%"` to `"80%"` so compression
waits until context exceeds 80% before firing the strong nudge.

## Semantics (why minContextLimit is left at 45%)

The nudge decision (`context-compress-algorithms` `computeShouldNudge`) is:

    shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit

`overMinLimit` only selects the `tipsVariant` tone ("minLimit" vs "maxLimit") once a
nudge is already firing — it never triggers a nudge on its own. So `minContextLimit`
is tone-only; leaving it at 45% does not cause early compression.

## Acceptance criteria

- `lib/config.ts` default compress block sets `maxContextLimit: "80%"` and
  `minContextLimit: "80%"` (aligned, removing the legacy 45% early-tip band).
- `emergencyThresholdPercent: "98%"` backstop unchanged.
- typecheck + test + build all green.
- Users can still override via `compress.maxContextLimit` in their config.

## Scope

Single-file change: `lib/config.ts`. Release-only metadata: `package.json`,
`README.md`, `README.zh-CN.md`, this devlog.
