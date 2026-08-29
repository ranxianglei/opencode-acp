# WORKLOG — 2026-08-29_min-nudge-providers-models

## 1. Overview

Replaces PR #345's flat `compress.modelMinNudgeLimits` map (`"provider/model"` string keys) with a nested `compress.providers.{provider}.models.{model}.minNudgeContextPercent` structure, cascading field-by-field as **model > provider > global** — the same design as the sibling project [billion-context-pi](https://github.com/ranxianglei/billion-context-pi/blob/master/CONFIGURATION.zh-CN.md).

- Stacked on PR #343 (`2026-08-28_min-gate-growth-nudges`) — the per-model floor rides on #343's `nudgeAllowed` gate.
- Supersedes PR #345 (`2026-08-28_model-min-nudge-limits`) — that PR is closed unmerged; its config surface never shipped, so there is zero migration cost.

## 2. Changes

### `lib/config.ts`
- New exported types: `CompressModelOverrides` (`{ minNudgeContextPercent?: number }`) and `CompressProviderOverrides` (extends it with `models?: Record<string, CompressModelOverrides>`).
- `CompressConfig.providers?: Record<string, CompressProviderOverrides>`.
- `mergeCompress` deep-merges providers across config file layers via `mergeProviderOverrides` / `mergeModelOverrides` / `stripUndefined` — per provider id, per model id, field-by-field. A project layer can narrow one provider without wiping others from lower layers (intentionally different from the flat maps' replace-inherit).
- `deepCloneConfig` cloned out as `export` (used by tests) and extended to clone the nested `providers` structure.

### `lib/messages/inject/utils.ts`
- `DEFAULT_MIN_NUDGE_CONTEXT_PERCENT = 5` (shared with inject.ts's #343 default).
- `resolveMinNudgeContextPercent(config, providerId?, modelId?): number | undefined` — the cascade; `0` is an explicit disable, unset returns `undefined`.
- `resolveMinNudgeFloorTokens(config, modelContextLimit, providerId?, modelId?): number | undefined` — clamps 0–100, rounds, × window; `undefined` when the window is unknown (floor stays open, growth-only — #343 semantics).

### `lib/messages/inject/inject.ts`
- Floor computation and policy passthrough now call the resolvers instead of reading `config.compress.minNudgeContextPercent` directly.

### `lib/config-validation.ts`
- `compress.providers` recognized as a dynamic-key path (like `modelMaxLimits`).
- `validatePercentField` / `validateModelOverrides` / `validateProviderOverrides`: percent must be a finite number 0–100; unknown fields rejected (typos like `minNudgeContextPecent` caught); models must be an object of override objects.

### `dcp.schema.json`
- `compress.providers` schema: provider objects allow `minNudgeContextPercent` + `models`; model objects allow `minNudgeContextPercent` only; `additionalProperties: false` at both levels.

### Docs
- `CONFIGURATION.md` + `CONFIGURATION.zh-CN.md`: new `compress.providers` section (semantics + example), `minNudgeContextPercent` cross-pointer, new recipe "Per-model growth-nudge floor".

## 3. Tests — 1053/1053 green (1036 baseline + 17 new)

- `tests/inject.test.ts` (+8): resolver cascade/precedence/fallback/0-disable/clamp/window-unknown; gate tests are multi-turn with side-effect assertions (§5.7): model-level 30% floor suppresses then fires, provider-level 25%, unknown provider → global, model-level 0 disables.
- `tests/config-providers.test.ts` (new, +9): mergeCompress deep-merge across layers, cannot-clear semantics, deepCloneConfig isolation, validation accept/reject matrix.

## 4. Mutation verification (§5.7.3)

| Mutation | Expected signal | Result |
|---|---|---|
| M1: skip model level in cascade | model-level resolver/gate tests fail | exactly 5 fail ✓ |
| M2: default `?? 5` → `?? 15` | default-floor tests fail | exactly 2 fail (#342 default-lock + new #344 default) ✓ |
| M3: deep-merge → replace | merge tests fail | exactly 2 fail (cannot-clear + deep-merge) ✓ |

## 5. Process incident

During the first mutation run, `git checkout` was used to revert a mutation — but the implementation was uncommitted, so the checkout wiped the new code in `lib/messages/inject/utils.ts` and `lib/config.ts`. Re-applied both files and re-verified (typecheck ✓, 1053/1053 ✓). Lesson recorded: mutation testing must back up files (`cp` → mutate → restore from copy), never `git checkout`, while work is uncommitted.

## 6. Commits

| Hash | Subject |
|---|---|
| `e14193c` | feat: per-provider/per-model growth-nudge floor via nested compress.providers (issue #344) + .gitignore symlink fix |
| (pending) | docs: CONFIGURATION + WORKLOG for the nested providers floor |
