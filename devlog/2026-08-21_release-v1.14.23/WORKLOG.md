# WORKLOG — v1.14.23

## Commits on this release (since v1.14.22)

1. `a6921bd` Merge PR #325 — effective compressible accounting:
   `CompressibleRange.effectiveTokens` (soft-filter survivors only), `resolveEffectiveFloor`
   (`minCompressRange÷4`, 0 when disabled), universal `effective > 0` guard, `nothingToCompress.allBelowMin`
2. `e9a6b08` Merge PR #326 — emergency no-target path emits actionable `/compact` notice
   (reply tool) instead of compress demands; stacked on #325
3. `c2c863b` Merge PR #327 — `nudgeGrowthTokens` fixed default 50K (uniform growthFloor 22.5K);
   E2E scenario configs pinned; stale adaptive docs dropped
4. `971d9b7` Merge PR #330 — auto-update by installed dist-tag: `specUpdateTag`, `updateTarget`,
   `isDistTag`, `/name/<tag>` registry check (fixes #328); +6 fail-first tests; docs ×4

## Release steps

- `npm version 1.14.23 --no-git-tag-version` (bump `package.json` + `package-lock.json`)
- `### v1.14.23` entries added to `CHANGELOG.md` and `CHANGELOG.zh-CN.md`
- Devlog: this folder (REQ.md + WORKLOG.md)
- Commit `release: v1.14.23 — fix batch (#325 #326 #327 #328)`

## Verification

- `npx tsc --noEmit` — green
- `node --import tsx --test tests/*.test.ts` — 1024 pass, 0 fail
- release.yml publishes v1.14.23 to npm `latest` after merge (tag v1.14.23 + GitHub Release)
