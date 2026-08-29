# REQ - All-field per-provider/per-model overrides via nested providers/models config

- Task ID: `2026-08-29_min-nudge-providers-models`
- Home Repo: `opencode-acp`
- Created: 2026-08-29
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: issue #344, PR #343 (floor gate + 5% default, MERGED — this PR is stacked on it), PR #345 (superseded flat-map design, closed), billion-context-pi `CONFIGURATION.zh-CN.md` §compress.providers (design reference)

## 1. Background & Problem Statement

- **Context**: Issue #344 wants per-model config: big-window models (e.g. 1M) need different nudge tuning than small-window ones, because a single global value binds at very different absolute token levels.
- **Current behavior**: #343 (merged) wires the global floor `compress.minNudgeContextPercent` (default 5%). PR #345 implemented per-model overrides as a **flat map** — rejected. The initial version of THIS PR shipped the nested structure for `minNudgeContextPercent` only.
- **Scope extension (2026-08-29, maintainer directive)**: “应该所有字段都需要三级别 而不是仅仅一个字段” — the nested cascade must cover **every tunable compress field**, not just the floor.
- **Expected behavior**: `compress.providers.{provider}.models.{model}.{field}` cascades **model > provider > global, field-by-field** for all overridable fields.
- **Impact**: Users get the documented bcp-style config shape for all tuning knobs in one place.

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
- **All-field cascade (scope extension)**: the same resolution applies to every overridable field — `maxContextLimit`, `emergencyThresholdPercent`, `nudgeFrequency`, `iterationNudgeThreshold`, `toolOutputNudgeThreshold`, `nudgeGrowthTokens`, `minNudgeGrowthRatio`, `minNudgeGrowthFloor`, `nudgeForce`, `protectedTools`, `showCompression`, `summaryBuffer`, `protectTags`, `protectUserMessages`, `maxSummaryLengthHard`, `minCompressRange`, `maxVisibleSegments`, `keepEmbedMaxChars`, `lastSegmentSoftBlock`, `preserveRecentMessages`, `preserveRecentTokens`, `preserveLastUserMessage`.
- **Not overridable**: `permission` (session-level, fixed before model info is known), deprecated `minContextLimit` / `modelMinLimits` family, flat `modelMaxLimits` (legacy), `providers` itself.
- **maxContextLimit precedence**: nested override > `modelMaxLimits` flat map > global. The blanket apply path (`applyCompressOverrides`) explicitly EXCLUDES `maxContextLimit` so the explicit chain in `resolveContextTokenLimit` stays authoritative.
- **Mechanism**: `applyCompressOverrides(config, providerId, modelId)` returns a shallow-cloned effective config; entry points swap it in right after model info is known — `injectCompressNudges` (inject.ts) reassigns the config param, the compress tool (range.ts) rebuilds `ctx` after `prepareSession`. Identity return (same reference, zero alloc) when no override applies.
- **Exceptions documented**: the system-prompt protected-tools listing (hooks.ts, built before model info is available) always reflects the global `protectedTools`.
- Three-layer file merge (global → configDir → project): `providers` maps deep-merge **per key / per field** (a project layer can add one provider without wiping the global layer's other providers). This intentionally differs from the flat `modelMaxLimits` replace-inherit semantics — nested maps merge naturally.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Stacked on #343 (`2026-08-28_min-gate-growth-nudges`, merged); must not break its tests.
  - AGENTS.md §5.7: nudge-logic changes need multi-turn tests + side-effect assertions.
  - No `as any` / `@ts-ignore` (type cast through `unknown` is used only at the config swap boundary).
- **Non-Goals**:
  - NOT absorbing/migrating existing flat `modelMaxLimits` / `modelMinLimits` (separate decision later).
  - NOT making `permission` overridable (tool registration happens before model info exists).
  - NOT touching the deprecated min family (deprecation handled by PR #352).

## 4. Acceptance Criteria

- **Correctness**:
  - [x] `resolveMinNudgeFloorTokens(config, modelContextLimit, providerId, modelId)` returns model > provider > global cascade, clamped 0–100, rounded; undefined context → undefined.
  - [x] inject gate uses resolver; policy passthrough sees the effective percent.
  - [x] `resolveCompressOverrides` merges provider then model fields (model wins per field); `applyCompressOverrides` swaps the effective config at both entry points, excludes `maxContextLimit`, identity when nothing applies.
  - [x] `resolveContextTokenLimit` honors nested `maxContextLimit` with precedence nested > flat `modelMaxLimits` > global.
  - [x] Config merge: L2/L3 deep-merge per provider/model key; deepClone isolates.
  - [x] Validation rejects: non-object providers, wrong-typed field values at both levels (per-field type table), unknown fields, non-object models entries.
  - [x] dcp.schema.json + CONFIGURATION.md + CONFIGURATION.zh-CN.md document the nested shape with the full field list.
  - [x] Tests: resolver cascade (model beats provider beats global, unknown falls back, 0 disables), inject multi-turn (floor suppressed→fired, over-max band per model, growth threshold per provider), merge tests, validation tests. Mutation-verified (M1–M5).
- **Performance**: O(1) lookups per turn; no measurable overhead.

## 5. Plan

1. `lib/config.ts`: `CompressModelOverrides` / `CompressProviderOverrides` types, `CompressConfig.providers`, merge helpers, deepClone.
2. `lib/messages/inject/utils.ts`: `resolveMinNudgeContextPercent` + `resolveMinNudgeFloorTokens` exports.
3. `lib/messages/inject/inject.ts`: use resolver (floor tokens + effective percent for policy).
4. `lib/config-validation.ts`: `validateProviderOverrides`.
5. `dcp.schema.json`, CONFIGURATION.md, CONFIGURATION.zh-CN.md.
6. Tests (inject + config merge + validation), typecheck, full suite, build.
7. Push, PR, close #345 as superseded.
