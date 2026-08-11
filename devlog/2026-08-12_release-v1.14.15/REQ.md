# REQ — v1.14.15: Pin nudge growth to fixed 50,000 tokens

## Background

The T2/T3 nudge growth threshold (`nudgeGrowthTokens`) was adaptive: 5% of the
model context window, clamped to [20000, 50000] via
`resolveAdaptiveNudgeGrowth` from the `context-compress-algorithms` dependency.
For sub-1M-context models this produced thresholds below 50K (e.g. 200K → 10K,
400K → 20K), causing nudges to fire too eagerly and drive over-compression.

A parallel change is being made in `acp-kernel` (v0.0.19, feeds
`billion-context` and `billion-context-pi`) and here in `opencode-acp` so all
three adapters use a single fixed 50,000-token growth threshold.

## Requirement

Set the default `compress.nudgeGrowthTokens` to a fixed `50000` in opencode-acp's
default config, overriding the adaptive value through the existing override hook
at `lib/messages/inject/inject.ts`
(`config.compress?.nudgeGrowthTokens ?? resolveAdaptiveNudgeGrowth(...)`).

## Acceptance criteria

- `lib/config.ts` default compress block sets `nudgeGrowthTokens: 50000`.
- typecheck + test + build all green.
- No test asserts the previous adaptive default (so none need updating).
- Users can still override via `compress.nudgeGrowthTokens` in their config.
- `emergencyThresholdPercent: "98%"` backstop remains unchanged.

## Scope

Single-file change: `lib/config.ts`. Release-only metadata: `package.json`,
`README.md`, `README.zh-CN.md`, this devlog.
