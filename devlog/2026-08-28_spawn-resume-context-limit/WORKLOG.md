# WORKLOG - Context-limit safety net never engages in spawn+resume mode (issue #346)

- Task ID: `2026-08-28_spawn-resume-context-limit`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-08-28

## 1. Summary

- **What was done** (1–3 sentences):
  Made the model context limit survive headless spawn+resume (persist it from
  the system hook, lazily hydrate the catalog during a request), added a
  configurable fallback window (`compress.contextLimitFallback`, default 128000) so the safety net works even when the limit is genuinely unknown,
  made in-flight tool-output truncation overhead-aware (window − system
  prompt − 16K output reserve), and added a loud ERROR log ("ACP hard guard")
  when the post-transform context still exceeds the model budget.
- **Why** (1–3 sentences):
  In spawn+resume mode the limit was learned and lost on every request, so
  every percentage threshold resolved to `undefined` and the entire safety net
  (nudges, GC, in-flight truncation) was silently disabled. Production sessions
  grew to the length-rejection wall (~229K tokens on a 262144 window) and
  entered an infinite empty-response retry loop with no error surfaced.
- **Behavior / compatibility changes**: Yes —
    - New config key `compress.contextLimitFallback` (default 128000; `0` =
      legacy behavior).
    - The system hook now persists `modelContextLimit` + model identity on
      change (state file shape is additive; fields already existed in the
      persisted schema).
    - In-flight truncation starts earlier: at
      `min(gc.majorGcThresholdPercent × limit, limit − systemPromptTokens − 16384)`
      instead of 100% of the window.
    - New ERROR log line when post-transform tokens exceed the budget.
    - Internal-agent (title/summary/compaction) system prompts no longer
      overwrite the session limit.
- **Risk level**: Medium (threshold behavior changes for unknown-limit
  sessions — previously "no safety net", now "safety net against 128K or the
  configured fallback"; disable with `contextLimitFallback: 0`).

## 2. Change Log

### Commits

| Commit  | Description                                                |
| ------- | ---------------------------------------------------------- |
| `<sha>` | fix: context-limit safety net for spawn+resume mode (#346) |

### Key Files

- `lib/hooks.ts` — system hook persists limit+identity on change (moved after
  the internal-agent signature check); messages transform lazily hydrates the
  catalog on a catalog miss (`registry.hydrateAndResolve`); transform log and
  new "ACP hard guard" ERROR use the effective limit; `OUTPUT_RESERVE_TOKENS`
  imported from truncate-tools.
- `lib/state/state.ts` — `SessionStateRegistry.hydrateAndResolve(client,
providerId, modelId)`: resolve → one lazy hydration per process on miss →
  re-resolve.
- `lib/state/utils.ts` — `resolveEffectiveContextLimit(state, config)` +
  `EffectiveContextLimit` type: model limit if known, else
  `compress.contextLimitFallback` if > 0, else `undefined`.
- `lib/config.ts` — `CompressConfig.contextLimitFallback?: number`, default
  128000, merged in `mergeCompress`.
- `lib/config-validation.ts` — `compress.contextLimitFallback` in
  `VALID_CONFIG_KEYS` + number/non-negative type validation.
- `dcp.schema.json` — `contextLimitFallback` schema entry.
- `lib/messages/inject/utils.ts` — `resolveContextTokenLimit` resolves
  percentage thresholds against the effective limit; `isContextOverLimits`
  reports the effective limit to downstream consumers (emergency override,
  displays, block guidance).
- `lib/messages/truncate-tools.ts` — `OUTPUT_RESERVE_TOKENS = 16384`;
  effective-limit gating; overhead-aware threshold; ERROR + bail when the
  window cannot fit the overhead.
- `lib/gc/merge.ts` — `runBatchCleanup` uses the effective limit.
- `lib/compress/decompress.ts` — context-usage displays use the effective
  limit.
- `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md` — documented
  `compress.contextLimitFallback`.
- `tests/model-switch-limits.test.ts` — 8 new tests (lazy hydration,
  persistence, internal-agent guard, hydrateAndResolve ×3, hard guard ×2);
  `runTransform` harness extended with `client`/`logger`/`config` options.
- `tests/truncate-tools.test.ts` — 3 new tests (production wall repro with
  the exact production numbers, overhead bail, fallback-driven truncation);
  2 pre-existing tests moved to a realistic 200K window (the old 1000-token
  window can no longer fit the 16K output reserve — by design).
- `tests/context-limit-fallback.test.ts` — new file: 9 tests for
  `resolveEffectiveContextLimit` and `isContextOverLimits` fallback behavior.
- `tests/registry-stub.ts` — `createTestRegistry` gained `hydrateAndResolve`
  mirroring the real registry.

## 3. Design & Implementation Notes

- **Entry point / key function**: `resolveEffectiveContextLimit`
  (`lib/state/utils.ts`) is the single source of truth for "which window does
  the safety net operate against"; every consumer (nudge thresholds, emergency
  override, GC, truncation, displays) goes through it.
- **Key configuration items**: `compress.contextLimitFallback` (default
  128000, `0` disables); `gc.majorGcThresholdPercent` (user escape hatch for
  larger `max_tokens` — the `min()` keeps the stricter bound).
- **Key logic explanation**:
    - Limit lifecycle: system hook learns the limit → persists on change →
      next spawned process loads it from the state file. If still unknown
      (first session, custom provider), the messages transform hydrates the
      catalog once per process from `client.config.providers()` (server is
      guaranteed up during a request). If still unknown, the fallback window
      applies.
    - Serving wall: a request fits only if `conversation + systemPromptTokens +
max_tokens ≤ max_model_len`. Truncation therefore starts at
      `min(configured threshold, limit − systemPromptTokens − 16384)`; if that
      is ≤ 0 the window is unusable and ACP logs an ERROR instead of
      truncating.
    - Hard guard: after the full transform pipeline, if `postTokens >
limit − systemPromptTokens − 16384`, ACP logs an ERROR with the budget
      breakdown. The exit-0 empty response itself is opencode-core behavior and
      cannot be changed from a plugin.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run specific test file
node --import tsx --test tests/<file>.test.ts

# Type check
npx tsc --noEmit
```

### Test Coverage

- New/modified test files: `tests/context-limit-fallback.test.ts` (new),
  `tests/model-switch-limits.test.ts`, `tests/truncate-tools.test.ts`,
  `tests/registry-stub.ts` (helper).
- Test count: 1049 total, 1049 pass, 0 fail (baseline 1029 before this
  change).
- Key scenarios verified:
    - **Pre-fix failure check (mandatory)**: with the source changes stashed,
      all 11 behavioral tests fail (lazy hydration, persistence,
      internal-agent guard, hydrateAndResolve ×3, hard guard, production wall
      repro, overhead bail, fallback truncation, fallback file import) —
      re-applying the fixes turns them green.
    - **Production repro**: limit 262144, systemPromptTokens 17000,
      currentTokens 229479 (the exact production token count) → truncation now
      fires (threshold 228760); pre-fix it was a no-op (229479 < 262144).
    - **Compatibility**: all 10 pre-existing #312 model-switch tests pass
      unchanged (their configs carry no `contextLimitFallback`, preserving the
      legacy invalidation semantics).

### Results

- `npm run typecheck`: pass
- `npm run test`: 1049/1049 pass
- `npm run build`: pass
