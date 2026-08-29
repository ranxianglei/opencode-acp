# REQ - Per-model growth-nudge floor via nested providers/models config

- Task ID: `2026-08-29_min-nudge-providers-models`
- Home Repo: `opencode-acp`
- Created: 2026-08-29
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: issue #344, PR #343 (floor gate + 5% default, unmerged — this PR is stacked on it), PR #345 (superseded flat-map design, to be closed), billion-context-pi `CONFIGURATION.zh-CN.md` §compress.providers (design reference)

## 1. Background & Problem Statement

- **Context**: Issue #344 wants per-model growth-nudge floors: big-window models (e.g. 1M) need a different `minNudgeContextPercent` than small-window ones, because a single global floor binds at very different absolute token levels.
- **Current behavior**: #343 (unmerged) wires the global floor `compress.minNudgeContextPercent` (default 5%). PR #345 implemented per-model overrides as a **flat map** `compress.modelMinNudgeLimits: Record<"provider/model", number|percent>`.
- **Expected behavior**: Maintainer decision (2026-08-29): the per-model config surface must follow the **nested hierarchy** used by the sibling project billion-context-pi — `compress.providers.{provider}.models.{model}.{field}`, cascading **model > provider > global, field-by-field**. #345's flat map is rejected; that PR will be closed unmerged (zero migration cost).
- **Impact**: Users get the documented bcp-style config shape. No shipped surface changes (neither #343 nor #345 has merged).

## 2. Design (target config)

```jsonc
{
  "compress": {
    "minNudgeContextPercent": 5,          // global (from #343, default 5)
    "providers": {
      "anthropic": {
        "minNudgeContextPercent": 8,       // provider-level override
        "models": {
          "claude-sonnet-4-6": {
            "minNudgeContextPercent": 10   // model-level override (highest)
          }
        }
      }
    }
  }
}
```

- Resolution: `providers[p].models[m].minNudgeContextPercent` → `providers[p].minNudgeContextPercent` → `compress.minNudgeContextPercent` (→ default 5). Unset fields do not clear shallower values. `0` is an explicit "disable the floor" (not "unset").
- Percent resolves against the **active model's** context window; unknown window → floor undefined (growth-only, same as #343).
- Exact provider/model id match (from `getModelInfo`, last user message `info.model`); unknown provider/model falls back up the cascade.
- The `providers` structure is designed to be **extensible**: later PRs can add more overridable fields (maxContextLimit, nudgeGrowthTokens, …) without changing the shape.
- Three-layer file merge (global → configDir → project): `providers` maps deep-merge **per key / per field** (a project layer can add one provider without wiping the global layer's other providers). This intentionally differs from the flat `modelMaxLimits` replace-inherit semantics — nested maps merge naturally.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Stacked on #343 (`2026-08-28_min-gate-growth-nudges`); must not break its tests.
  - AGENTS.md §5.7: nudge-logic changes need multi-turn tests + side-effect assertions.
  - No `as any` / `@ts-ignore`.
- **Non-Goals**:
  - NOT absorbing/migrating existing flat `modelMaxLimits` / `modelMinLimits` (separate decision later).
  - NOT adding other overridable fields yet (structure allows; fields come in follow-ups).
  - NOT touching `nudgeGrowthTokens` per-model (yet).

## 4. Acceptance Criteria

- **Correctness**:
  - [ ] `resolveMinNudgeFloorTokens(config, modelContextLimit, providerId, modelId)` returns model > provider > global cascade, clamped 0–100, rounded; undefined context → undefined.
  - [ ] inject gate uses resolver; policy passthrough sees the effective percent.
  - [ ] Config merge: L2/L3 deep-merge per provider/model key; deepClone isolates.
  - [ ] Validation rejects: non-object providers, non-number/negative/>100 percent, non-object models entries.
  - [ ] dcp.schema.json + CONFIGURATION.md + CONFIGURATION.zh-CN.md document the nested shape.
  - [ ] Tests: resolver cascade (model beats provider beats global, unknown falls back, 0 disables), inject multi-turn (suppressed below floor → fires above), merge tests, validation tests. Mutation-verified.
- **Performance**: O(1) lookups per turn; no measurable overhead.

## 5. Plan

1. `lib/config.ts`: `CompressModelOverrides` / `CompressProviderOverrides` types, `CompressConfig.providers`, merge helpers, deepClone.
2. `lib/messages/inject/utils.ts`: `resolveMinNudgeContextPercent` + `resolveMinNudgeFloorTokens` exports.
3. `lib/messages/inject/inject.ts`: use resolver (floor tokens + effective percent for policy).
4. `lib/config-validation.ts`: `validateProviderOverrides`.
5. `dcp.schema.json`, CONFIGURATION.md, CONFIGURATION.zh-CN.md.
6. Tests (inject + config merge + validation), typecheck, full suite, build.
7. Push, PR, close #345 as superseded.
