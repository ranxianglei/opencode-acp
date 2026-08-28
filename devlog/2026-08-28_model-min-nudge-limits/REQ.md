# REQ - Per-model growth-nudge floor (modelMinNudgeLimits) for mixed-context installs

- Task ID: `2026-08-28_model-min-nudge-limits`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: Done
- Priority: P2
- Owner: ework-daemon (qwen3.8-27b)
- References: issue ranxianglei/opencode-acp#344, PR #343 (branch `2026-08-28_min-gate-growth-nudges`), issue #342

## 1. Background & Problem Statement

- **Context**: PR #343 makes the T1 growth-nudge floor the **global** `minNudgeContextPercent` (default 15% of the model context window). Mixed-model installations cannot express per-model floors with a single global percent:

  | Model | Advertised window | Intended floor | Floor at global 37.5% | Floor at default 15% |
  |-------|------------------|----------------|----------------------|---------------------|
  | OpenAI GPT-5.6 (native) | 400,000 | 150,000 | 150,000 ✓ | 60,000 (reproduces #342 early nudges) |
  | `openrouter/z-ai/glm-5.3` | 1,048,576 (OpenRouter API) | 200,000 | 393,216 (≈2× intended) | 157,286 |

  No single global value satisfies both: 37.5% delays the GLM floor to nearly twice the intended value; 15% puts native OpenAI back at 60K.
- **Current behavior (symptom)**: a single global `minNudgeContextPercent` cannot express per-model floors; users must pick a compromise that mis-tunes at least one model.
- **Expected behavior**:
  - New optional config `compress.modelMinNudgeLimits: Record<string, number | `${number}%`>` keyed by `provider/model` (same keying as `modelMaxLimits` / `modelMinLimits`).
  - Values may be absolute tokens or `"X%"` of that model's context window.
  - Precedence:
    1. `modelMinNudgeLimits[provider/model]`
    2. `minNudgeContextPercent` × model context
    3. existing growth-only behavior when model context is unknown
  - The existing `modelMinLimits` keeps its current turn/iteration-reminder meaning (unchanged).
- **Impact**: mixed-model installs (e.g. native OpenAI 400K + OpenRouter GLM 1M) can set exact token or percentage floors per model instead of a single global compromise.

## 2. Reproduction (if applicable)

- **Environment**: opencode-acp with PR #343 applied, Node 22/24, a session alternating between two models with different advertised context windows.
- **Minimal reproduction steps**:
  1. Use a 400K-window model and a 1M-window model in one installation.
  2. Set `minNudgeContextPercent` to 37.5 (floor 150K on the 400K model).
  3. On the 1M model the floor becomes 393K — nearly 2× the intended 200K.
- **Relevant configuration**: `compress.minNudgeContextPercent`, `compress.modelMinNudgeLimits` (new).

## 3. Root cause

- The floor computation in `injectCompressNudges` (`minNudgeFloorTokens` / `overMinNudgeFloor`, `lib/messages/inject/inject.ts`) only consults the global `minNudgeContextPercent`; there is no per-model override hook. The existing `modelMaxLimits` / `modelMinLimits` per-model pattern (`resolveContextTokenLimit` in `lib/messages/inject/utils.ts`) is not applied to the nudge floor.

## 4. Constraints & Non-Goals

- **Constraints**:
  - Follow the existing `modelMinLimits` pattern exactly: same keying (`provider/model`), same value type (`number | `${number}%``), same validation, same merge/clone treatment.
  - Precedence order as proposed in the issue: per-model entry → global percent → growth-only fallback when model context is unknown.
  - An absolute per-model token floor must work even when the model context window is unknown (mirrors `modelMaxLimits`/`modelMinLimits` behavior); a per-model percent with unknown model context falls through to the global percent (also unresolvable → growth-only).
  - `modelMinLimits` semantics are unchanged (turn/iteration reminders).
  - `overMaxLimit` and the emergency override still bypass the floor; T2/T3 tier-promotion nudges remain independent.
  - No new dependencies; no change to persisted state format or internal `dcp` tags.
  - No `version` bump in `package.json` (feature branch; release handled separately).
- **Non-Goals** (out of scope):
  - Merging PR #343 (this PR is based on it and lands after it).
  - Per-model `nudgeGrowthTokens` or growth-ratio overrides.
  - Wildcard/prefix model keys (exact `provider/model` keys only, like the existing model limits).

## 5. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] A per-model absolute floor in `modelMinNudgeLimits` wins over the global `minNudgeContextPercent` for that model (nudge suppressed below the per-model floor, fires at/above it).
  - [ ] A per-model percent floor resolves against the per-model context window (e.g. `"25%"` of 1M = 250K).
  - [ ] Models without a per-model entry keep using the global `minNudgeContextPercent` floor.
  - [ ] Unknown model context: global floor unresolvable → growth-only behavior unchanged; per-model absolute floor still applies; per-model percent unresolvable → falls through to global (growth-only).
  - [ ] `modelMinLimits` behavior is unchanged (no cross-interference).
  - [ ] `overMaxLimit` bypass and the emergency override are unaffected by per-model floors.
- **Config plumbing**:
  - [ ] `compress.modelMinNudgeLimits` is a valid config key (no "unknown key" warning) and is type-validated like `modelMinLimits` (object of `number | "X%"`).
  - [ ] Three-layer merge: an explicit per-layer record replaces the inherited one (same `??` semantics as `modelMinLimits`).
  - [ ] `dcp.schema.json` documents the new property.
- **Docs**:
  - [ ] `CONFIGURATION.md` and `README.md` document `modelMinNudgeLimits`.
- **Tests**:
  - [ ] New tests in the `issue #344:` block of `tests/inject.test.ts` covering all correctness criteria above, including a multi-turn cycle with side-effect assertions on `lastPerMessageNudgeTokens` / `lastNudgeShownTokens` and a production-config (`preserveRecentMessages > 0`) variant.
  - [ ] `tests/config-validation.test.ts` covers the new key (non-recursion + type validation).
