# WORKLOG — v1.14.16: Raise context limit to 80%

## Investigation

- `maxContextLimit` / `minContextLimit` are resolved in
  `lib/messages/inject/utils.ts` `isContextOverLimits` → `overMaxLimit`
  (`currentTokens > maxContextLimit`) and `overMinLimit`
  (`currentTokens >= minContextLimit`).
- These feed `computeShouldNudge` (delegated to `context-compress-algorithms`):
  `shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit`.
  `overMinLimit` only picks `tipsVariant` (`overMaxLimit ? "maxLimit" : overMinLimit ?
  "minLimit" : "normal"`) — it does not trigger a nudge by itself.
- Conclusion: `maxContextLimit` is the load-bearing threshold; `minContextLimit` is
  tone-only. Raise `maxContextLimit` to 80% (the meaningful change), and set
  `minContextLimit` to 80% too so the legacy 45% early-tip band is removed entirely
  and behavior is uniform (`minContextLimit` carries no trigger semantics, so
  aligning it with `maxContextLimit` is safe).

## Change

`lib/config.ts` defaultConfig compress block:

```diff
-        maxContextLimit: "55%",
-        minContextLimit: "45%",
+        maxContextLimit: "80%",
+        minContextLimit: "80%",
```

## Verification

- typecheck (`tsc --noEmit`): clean.
- tests (`node --import tsx --test tests/*.test.ts`): 976 pass / 0 fail.
- build (`tsup && tsc --emitDeclarationOnly`): success.

## Release

- Version bump 1.14.15 → 1.14.16 (package.json).
- Changelog entries in README.md + README.zh-CN.md.
- Branch `2026-08-12_release-v1.14.16`, commit `release: v1.14.16 — ...`.
- CI auto-publishes on merge (release.yml detects `YYYY-MM-DD_release-v*` branch).
