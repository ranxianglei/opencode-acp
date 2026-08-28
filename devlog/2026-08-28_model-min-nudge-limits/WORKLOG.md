# WORKLOG - Per-model growth-nudge floor (modelMinNudgeLimits) for mixed-context installs

- Task ID: `2026-08-28_model-min-nudge-limits`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-28

## 1. Summary

- **What was done**: added `compress.modelMinNudgeLimits: Record<string, number | `${number}%`>` — an optional per-model override for the T1 growth-nudge floor introduced by PR #343 (issue #342). Keyed by `provider/model` (same keying as `modelMaxLimits` / `modelMinLimits`); values are absolute tokens or `"X%"` of that model's context window. Floor resolution extracted into `resolveMinNudgeFloorTokens()` in `lib/messages/inject/utils.ts` with the precedence: (1) per-model entry, (2) global `minNudgeContextPercent` × model context, (3) `undefined` (growth-only) when the model context is unknown. Full config plumbing (type, validation, merge, deep-clone, JSON schema) follows the `modelMinLimits` pattern exactly.
- **Why**: a single global `minNudgeContextPercent` cannot express per-model floors for mixed-model installs — e.g. a 37.5% global floor gives 150K on a 400K-window model (intended) but 393K on a 1M-window model (≈2× the intended 200K), while 15% gives 60K on the 400K model (reproducing the #342 early-nudge symptom). Per-model floors let each model carry its own exact token or percentage floor.
- **Behavior / compatibility changes**: NO for existing setups — when `modelMinNudgeLimits` is unset (default), the floor computation is byte-for-byte the PR #343 global computation. Only installs that opt in to the new field change behavior. No change to persisted state format or internal `dcp` tags; `modelMinLimits` semantics untouched.
- **Risk level**: Low — one extracted helper on an existing decision path; global fallback path unchanged; max/emergency bypasses and T2/T3 untouched.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `50a117e` | feat: per-model growth-nudge floor `modelMinNudgeLimits` (issue #344) |
| `4c9d772` | docs: zh-CN doc parity for `modelMinNudgeLimits` (dual-agent review follow-up) |
| `<pending>` | docs: restore #343 floor-redesign wording that the stack reverted (EN+ZH docs, test header, utils comment, #343 devlog) |

### Key Files

- `lib/messages/inject/utils.ts` — new exported `resolveMinNudgeFloorTokens(config, modelContextLimit, providerId, modelId)`: per-model absolute tokens apply even with unknown model context (mirrors `modelMaxLimits`); per-model `"X%"` requires the model context (clamped 0–100, rounded) and falls through to the global percent when unresolvable; global path is the PR #343 computation verbatim.
- `lib/messages/inject/inject.ts` — `minNudgeFloorTokens` now comes from `resolveMinNudgeFloorTokens(config, modelContextLimit, providerId, modelId)` (provider/model from the existing `getModelInfo(messages)` call); `overMinNudgeFloor` / `nudgeAllowed` logic unchanged.
- `lib/config.ts` — `CompressConfig.modelMinNudgeLimits` field; `mergeCompress` (`??` replace-inherited semantics, same as `modelMinLimits`); `deepCloneConfig` shallow-copies the record.
- `lib/config-validation.ts` — `compress.modelMinNudgeLimits` in `VALID_CONFIG_KEYS`; excluded from key recursion in `getConfigKeyPaths` (dynamic keys); validated by the existing `validateModelLimits` (object of `number | "X%"`, per-entry error at `compress.modelMinNudgeLimits.<provider/model>`).
- `dcp.schema.json` — `modelMinNudgeLimits` property (object, additionalProperties `number | "X%"` pattern).
- `CONFIGURATION.md` — new `#### compress.modelMinNudgeLimits` section (type/default/precedence/example); `minNudgeContextPercent` section cross-references it; per-model context limits example extended.
- `README.md` — commented `modelMinNudgeLimits` example after the `modelMinLimits` example.
- `CONFIGURATION.zh-CN.md` — zh-CN parity (added in the review follow-up): new `#### compress.modelMinNudgeLimits` section, `minNudgeContextPercent` cross-reference, per-model limits example extended.
- `README.zh-CN.md` — commented `modelMinNudgeLimits` example after the `modelMinLimits` example.
- `tests/inject.test.ts` — `userMsgWithModel()` helper (sets `info.model` so `getModelInfo` resolves provider/model) + 9-test `issue #344:` block.
- `tests/config-validation.test.ts` — non-recursion test + 3 `validateConfigTypes` tests (valid entries, invalid entry, non-object).

## 3. Design & Implementation Notes

- **Entry point / key function**: `resolveMinNudgeFloorTokens()` in `lib/messages/inject/utils.ts`, called from `injectCompressNudges()` in `lib/messages/inject/inject.ts`.
- **The change** (utils.ts):
  ```ts
  export function resolveMinNudgeFloorTokens(
      config: PluginConfig,
      modelContextLimit: number | undefined,
      providerId: string | undefined,
      modelId: string | undefined,
  ): number | undefined {
      const parseModelLimit = (limit: number | `${number}%`): number | undefined => {
          if (typeof limit === "number") return limit
          if (modelContextLimit === undefined) return undefined
          const parsedPercent = parseFloat(limit.slice(0, -1))
          if (isNaN(parsedPercent)) return undefined
          const clampedPercent = Math.max(0, Math.min(100, Math.round(parsedPercent)))
          return Math.round((clampedPercent / 100) * modelContextLimit)
      }
      const modelLimits = config.compress.modelMinNudgeLimits
      if (modelLimits && providerId !== undefined && modelId !== undefined) {
          const modelLimit = modelLimits[`${providerId}/${modelId}`]
          if (modelLimit !== undefined) {
              const resolved = parseModelLimit(modelLimit)
              if (resolved !== undefined) return resolved
              // Per-model percent with unknown model context: fall through to the global percent.
          }
      }
      if (modelContextLimit === undefined) return undefined
      return Math.round(((config.compress.minNudgeContextPercent ?? 15) / 100) * modelContextLimit)
  }
  ```
- **Precedence decisions**:
  - Per-model **absolute** tokens apply even when the model context window is unknown — mirrors `modelMaxLimits` / `modelMinLimits` (absolute limits never needed the window). This is the only way a mixed install can pin a floor for a model that doesn't report `limit.context`.
  - Per-model **percent** with unknown model context falls through to the global percent — which is also unresolvable without the window — so the floor stays open (growth-only), preserving the PR #343 fallback.
  - Global fallback is the PR #343 computation verbatim (`Math.round(((minNudgeContextPercent ?? 15) / 100) * modelContextLimit)`), so unset `modelMinNudgeLimits` is behavior-identical to PR #343.
- **Why a helper instead of inlining in inject.ts**: the percent-parse/clamp logic duplicates `parseLimitValue` in `resolveContextTokenLimit`; a named exported helper keeps `injectCompressNudges` readable and makes the precedence unit-testable. (A full merge of the two resolvers was considered and rejected — the nudge floor has different fallback semantics: nudge floor is open by default when unresolvable, context limits are closed.)
- **Merge semantics**: explicit per-layer record replaces the inherited one (`override.modelMinNudgeLimits ?? base.modelMinNudgeLimits`) — identical to `modelMaxLimits` / `modelMinLimits`; no per-key deep merge (consistent with existing model limits).
- **Tests** (`tests/inject.test.ts`, `issue #344:` block, 9 tests):
  1. Per-model absolute floor (150K) wins over global 15% (60K) on a 400K window — multi-turn: suppressed at 100K (asserts `shouldInjectThisTurn` + `lastNudgeShownTokens` + `lastPerMessageNudgeTokens` baseline preserved), fires at 150K with baseline unchanged.
  2. Per-model `"20%"` resolves against the per-model 1,048,576 window → 209,715; suppressed at 180K (which passes the 157,286 global floor), fires at 250K.
  3. Model without a per-model entry keeps the global floor (30% of 1M = 300K suppresses 200K on an unlisted `anthropic/claude-sonnet-4.6`).
  4. Per-model absolute floor applies with unknown model context (150K floor suppresses 100K, fires at 180K).
  5. Per-model percent with unknown model context falls through to growth-only (fires at 100K).
  6. Production config (`preserveRecentMessages: 2`): per-model 300K floor suppresses 200K where the 150K global floor would have fired.
  7. Full growth cycle with a per-model floor: baseline 150K → nudge at 250K → compress resets baseline to 180K → nudge at 230K (self-reset verified via `lastPerMessageNudgeTokens` / `lastNudgeShownTokens` each turn).
  8. `overMaxLimit` bypasses the per-model floor (550K > 500K max fires despite an 800K floor).
  9. `modelMinLimits` independence: a 900K per-model min limit does not lower turn/iteration reminders (`turnNudgeAnchors` empty at 200K) while the 100K nudge floor still gates the growth path.
  - **Mutation check (AGENTS.md §5.7)**: with the per-model branch temporarily disabled (`if (false && ...)`), tests 1, 2, 4, 6 fail and the fallback/bypass/independence tests (3, 5, 7, 8, 9) still pass — exactly the expected split. Re-applied the fix; all green.
  - Config plumbing tests: `tests/config-validation.test.ts` — non-recursion into dynamic keys; valid entries (`150000`, `"20%"`) accepted; invalid entry (`"lots"`) rejected at `compress.modelMinNudgeLimits.openai/gpt-5.6`; non-object record rejected.
- **Formatting note**: the repo is not prettier-clean under the installed prettier (3.9.5) or the pinned minimum (3.8.1) — identical churn on untouched HEAD files (e.g. the 120-char import at `lib/config.ts:6` exists on `origin/master`, and both CONFIGURATION docs carry ~69 pre-existing prettier hunks), and CI does not run `format:check`. All **added** lines in `lib/`, `tests/`, and `dcp.schema.json` were verified prettier-clean (hunk-overlap check per file); pre-existing churn was left untouched to keep the diff reviewable. The JSONC examples in the four docs keep the file's existing no-trailing-comma style for internal consistency (only a comma was added where the edit made a previously-last property non-last, which JSONC validity requires).
- **Dual-agent review** (AGENTS.md §5.3/§5.6, two independent agents on `ecfe7f0..50a117e`): both returned NO BLOCKERS. Code review verified the full precedence contract (5/5), edge cases (`""` rejected, `"0%"` → floor 0, `"150%"` clamped to 100, undefined provider guarded, mid-session model switch, `deepCloneConfig` on undefined record), and independently reproduced the mutation-check split. Test review verified §5.6 (imports, name fidelity, config completeness, token math) and §5.7 (multi-turn, side-effect assertions, production config, growth cycle) all PASS. One should-fix — missing zh-CN doc parity — was applied in the follow-up commit above. Nits not taken: negative-number validation gap (pre-existing, shared with `modelMaxLimits`/`modelMinLimits`), `userMsgWithModel` duplicating `userMsg` (cosmetic; the existing helper is shared with older tests).
- **Verification**: `npm run typecheck` ✓, `npm run build` ✓, `npm run test` ✓ (1048 pass / 0 fail, including 9 new inject tests + 4 new config-validation tests), `./scripts/ci/check-pr.sh` ✓ (branch name, devlog, version unchanged).
