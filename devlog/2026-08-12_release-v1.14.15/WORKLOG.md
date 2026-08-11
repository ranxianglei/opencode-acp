# WORKLOG — v1.14.15: Pin nudge growth to fixed 50,000 tokens

## Investigation

- opencode-acp does NOT own its nudge-growth math. It imports
  `defaultTriggerPolicy` from external npm pkg `context-compress-algorithms`
  (ranxianglei's; npm 1.3.0). That pkg's `resolveAdaptiveNudgeGrowth(limit)` =
  `min(NUDGE_GROWTH_CAP, max(NUDGE_GROWTH_FLOOR, round(limit * NUDGE_GROWTH_RATIO)))`.
- Override chain: `lib/messages/inject/inject.ts:250-251` reads
  `config.compress?.nudgeGrowthTokens ?? resolveAdaptiveNudgeGrowth(modelContextLimit)`.
  The `??` hook lets a config value override the adaptive default — but opencode-acp's
  default config did not set `nudgeGrowthTokens`, so it always fell through to adaptive.
- Decision: self-contained override in opencode-acp's own default config (not a
  `context-compress-algorithms` release). Aligns with the "4 PRs" count
  (acp-kernel + opencode-acp + billion-context + billion-context-pi) and uses the
  existing override hook with no source-logic change.

## Change

`lib/config.ts` defaultConfig compress block — added one line after
`minNudgeGrowthFloor: 5000,`:

```ts
nudgeGrowthTokens: 50000,
```

Type `CompressConfig.nudgeGrowthTokens?: number` (config.ts:21) — type-correct.

## Verification

- typecheck (`tsc --noEmit`): clean.
- tests (`node --import tsx --test tests/*.test.ts`): 976 pass / 0 fail.
- build (`tsup && tsc --emitDeclarationOnly`): success, dist/index.js 391.34 KB.

## Release

- Version bump 1.14.14 → 1.14.15 (package.json).
- Changelog entries in README.md + README.zh-CN.md.
- Branch `2026-08-12_release-v1.14.15`, commit `release: v1.14.15 — ...`.
- CI auto-publishes on merge (release.yml detects `YYYY-MM-DD_release-v*` branch).
