# WORKLOG — 2026-08-29_deprecate-min-context-limit

## 1. Overview

Marks `compress.minContextLimit` and `compress.modelMinLimits` as **deprecated** (soft: annotations only, behavior unchanged). The growth-nudge floor (`minNudgeContextPercent` + `nudgeGrowthTokens`, #343/#351) is the maintained "minimum" mechanism going forward.

Stacked on #351 (`2026-08-29_min-nudge-providers-models`), which is stacked on #343. Merge order: #343 → #351 → this.

## 2. Changes

| File | Change |
|---|---|
| `lib/config.ts` | `@deprecated` JSDoc on `minContextLimit` + `modelMinLimits` (removal consequence noted) |
| `dcp.schema.json` | `[DEPRECATED — …]` description prefix on both properties |
| `CONFIGURATION.md` | Status → DEPRECATED for both; deprecation note incl. removal consequence; legend line 38 reworded to cover soft deprecation ("may still take effect until then") |
| `CONFIGURATION.zh-CN.md` | Same as EN; additionally fixed the stale default `45%` → `80%` (code default, `lib/config.ts`) |
| devlog | This REQ/WORKLOG |

Behavior: **none changed** — `resolveContextTokenLimit(…, "min")`, `overMinLimit`, anchor set/clear in `inject.ts` untouched.

## 3. Verification

- `npm run typecheck` ✓
- Full suite: 1053/1053 ✓ (unchanged from #351 — annotation-only change, no behavior drift)
- CI (pr-validation / test 22 / test 24 / build / build-artifact / e2e) ✓

## 4. Commits

| Hash | Subject |
|---|---|
| `43a15e7` | docs(deprecate): mark minContextLimit + modelMinLimits deprecated (soft, no behavior change) |
