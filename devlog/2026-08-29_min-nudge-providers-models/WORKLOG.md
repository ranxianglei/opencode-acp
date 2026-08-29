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

---

# Extension: all-field cascade (2026-08-29, same PR)

Maintainer directive: "应该所有字段都需要三级别 而不是仅仅一个字段" — every tunable compress field gets the nested cascade, not just `minNudgeContextPercent`.

## E1. Implementation

- `lib/config.ts`: `CompressOverridableConfig = Omit<CompressConfig, 'permission' | 'minContextLimit' | 'modelMaxLimits' | 'modelMinLimits' | 'providers'>`; `CompressModelOverrides = Partial<CompressOverridableConfig>`; `CompressProviderOverrides` unchanged shape (`models?` sub-map). Merge helpers unchanged (they were already field-generic).
- `lib/messages/inject/utils.ts`:
  - `resolveCompressOverrides(config, providerId?, modelId?)` — merged override set (provider fields spread, model entry spread on top; `models` key stripped).
  - `applyCompressOverrides(config, providerId?, modelId?)` — shallow-clones `{...config, compress: {...compress, ...applied}}`; **excludes `maxContextLimit`** (explicit chain below stays authoritative); identity (same reference) when nothing applies.
  - `resolveContextTokenLimit` now exported; honors nested `maxContextLimit` with precedence **nested > flat `modelMaxLimits` > global** (min threshold has no nested override — deprecated family).
- `lib/messages/inject/inject.ts`: right after `getModelInfo`, `config = applyCompressOverrides(config, providerId, modelId)` — param reassignment, all downstream reads (getNudgeFrequency, iterationNudgeThreshold, nudgeForce, summaryBuffer, nudgeGrowthTokens, growthFloor inputs, emergency threshold, protectedTools, preserve*, lastSegmentSoftBlock, resolveEffectiveFloor) pick up the cascade.
- `lib/compress/range.ts`: after `prepareSession`, `ctx = {...ctx0, config: applyCompressOverrides(ctx0.config, providerId, modelId)}` via `getModelInfo(rawMessages)`; early validation (`maxLen`) stays on `ctx0` (model info not yet available).
- `lib/config-validation.ts`: per-field type table `OVERRIDE_FIELD_TYPES` (boolean / nonNegativeNumber / positiveNumber / percent / limit / nudgeForce / stringArray) covering all 24 overridable fields; generic unknown-field rejection at both levels; `validatePercentField` / `validateLimitValue` reused for exact error parity.
- `dcp.schema.json`: `providers` nested schema lists all 23 model-level / 24 provider-level (+`models`) properties, `additionalProperties: false`.

## E2. Documented exceptions

- `permission`: not overridable (tool registration precedes model info).
- Deprecated `minContextLimit` / `modelMinLimits`: no nested surface (PR #352 deprecates them).
- `maxContextLimit`: nested beats the flat map (explicit precedence chain).
- System-prompt protected-tools listing (hooks.ts:128): global value only (prompt build precedes model info).

## E3. Tests — 1061/1061 green (+8)

- `tests/config-providers.test.ts` (+6): all-field resolver cascade (model wins per field, sibling/provider-only/unknown), identity swap, swap-excludes-maxContextLimit + input not mutated, nested-max precedence over flat map, multi-field validation accept matrix, wrong-typed rejects at both levels (nudgeForce enum, protectedTools array, positiveNumber, boolean, limit string, structural non-overridables).
- `tests/inject.test.ts` (+2, §5.7 multi-turn + side-effect assertions): model-level `maxContextLimit` lowers the over-max band (baseline 220K → growth 30K: ≥22.5K growthFloor, <50K threshold, so ONLY over-max can fire; turn 2 same context on unknown provider → no nudge); provider-level `nudgeGrowthTokens` tightens the growth threshold (8K growth fires at 5K override; same growth on unknown provider suppressed at 50K default).

## E4. Mutation verification (all exact)

| Mutation | Result |
|---|---|
| M1: skip model level | 9 fail (resolver + floor gates + new cascade tests) ✓ |
| M2: default 5 → 15 | exactly 2 fail ✓ |
| M3: deep-merge → replace | exactly 2 fail ✓ |
| M4: remove nested-max block in resolveContextTokenLimit | exactly 2 fail (precedence test + over-max band inject test) ✓ |
| M5: remove inject.ts config swap | exactly 1 fail (growth-threshold override test) ✓ |

Design note on M4: the first version of the over-max band test used `lastPerMessageNudgeTokens = 0` — the growth path fired anyway (non-discriminating; it survived M4). Fixed by raising the baseline to 220K so growth (30K) sits between growthFloor (22.5K) and the threshold (50K): only the over-max path can fire.

## E5. Docs

- CONFIGURATION.md / CONFIGURATION.zh-CN.md: `compress.providers` section rewritten — full overridable field list, not-overridable list, maxContextLimit precedence note, system-prompt exception, multi-field example; new recipe "Per-model tuning of any compress field" (EN+zh).
