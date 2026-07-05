# WORKLOG - Adaptive nudgeGrowthTokens + System Prompt Gating + acp_status

- Task ID: `2026-07-04_nudge-growth-tokens`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-05 10:15

## 1. Summary

- **What was done**: Replaced fixed 6K nudge growth threshold with adaptive scaling (5% of context limit, clamped [6K, 50K]). Added system prompt gating behind same frequency. Added `acp_status` tool for on-demand block inspection. Fixed compress header to show context before→after. Fixed multiple bugs (lastNudgeTokens reset, schema default override, duplicate injection).
- **Why**: Large-context models (1M+) were over-compressing at 20-30% context because Tips fired every 6K (0.6% of 1M). System prompt injected every turn added pressure. Model couldn't inspect compressed blocks without decompressing.
- **Behavior / compatibility changes**: Yes — `nudgeGrowthTokens` schema default removed (was 6000, now adaptive). `lastPerMessageNudgeTokens` type changed to `number | undefined`. `sendCompressNotification` gained required `contextTokensBefore` param.
- **Risk level**: Medium (nudge frequency logic changes affect all sessions)

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `91d82c7` | feat: nudgeGrowthTokens — token-based Tips gating (default 6K) |
| `2984326` | refactor: extract computeShouldNudge for testability + review fixes |
| `e5c8b24` | feat(notify): show context before→after level in compress header |
| `0633049` | fix(notify): drop context limit/percentage from header to avoid model anchoring |
| `2208f6d` | feat(nudge): adaptive nudgeGrowthTokens — 5% of context limit, clamped [6K, 50K] |
| `ebbd859` | fix(inject): gate injectContextUsage by shouldNudge — stop every-message spam |
| `31ea7c6` | fix(inject): gate ALL suffix content behind shouldNudge — zero compression noise between nudges |
| `efb0a65` | feat: add acp_status tool + simplify suffix to compact summary |
| `24bbb1f` | feat: gate system prompt behind nudgeGrowthTokens frequency |
| `e9fcd20` | fix: nudgeGrowthTokens dead code + duplicate context usage injection |
| `1d6fbe5` | fix: compress resetting lastNudgeTokens to 0 bypassed growth gate |
| `8eb0c49` | test: add integration tests for post-compress nudge state transitions |
| `a3e5410` | feat: add scripts/dev-deploy.sh — one-command build + deploy |
| `820001c` | fix: remove schema default 6000 + dedup formatAge |
| `5712103` | fix: review suggestions — sentinel semantics, idWidth, nullglob, acp_status tests |

### Key Files

- `lib/messages/inject/utils.ts` — `computeShouldNudge()` extracted as pure function; `resolveAdaptiveNudgeGrowth()` added (clamp 5%, [6K, 50K]); `buildContextUsageGuidance` call removed from `applyAnchoredNudges` (dedup)
- `lib/messages/inject/inject.ts` — uses adaptive default; gates ALL suffix content behind `shouldNudge`; `lastPerMessageNudgeTokens = currentTokens` (not 0) after compress; `shouldInjectThisTurn` stored for system prompt gating
- `lib/hooks.ts` — system prompt injection gated by `state.nudges.shouldInjectThisTurn` (1-turn lag)
- `lib/compress/status.ts` — NEW: `acp_status` tool, returns formatted block table
- `lib/compress/pipeline.ts` — captures `contextTokensBefore` for notification
- `lib/ui/notification.ts` — header shows `Context XK→YK` (absolute only, no %/total)
- `lib/prompts/extensions/nudge.ts` — suffix simplified to one-liner with `acp_status` reference
- `lib/state/types.ts` — `lastPerMessageNudgeTokens: number | undefined`; `shouldInjectThisTurn: boolean | undefined`
- `lib/config.ts` — `nudgeGrowthTokens` optional (no hardcoded default)
- `dcp.schema.json` — removed `nudgeGrowthTokens` default from field + default object
- `scripts/dev-deploy.sh` — NEW: build + deploy in one command

## 3. Design & Implementation Notes

- **Adaptive default**: `resolveAdaptiveNudgeGrowth(modelContextLimit)` = `clamp(round(limit × 0.05), 6000, 50000)`. Uses absolute tokens (not %) so the model sees a concrete threshold. Cap prevents explosion for future multi-million contexts.
- **System prompt gating**: 1-turn lag by design — system hook (`experimental.chat.system.transform`) runs before messages hook (`experimental.chat.messages.transform`). `undefined` = first turn = inject. `false` = skip entirely. Stored in `state.nudges.shouldInjectThisTurn`.
- **lastNudgeTokens sentinel**: Changed from `0` (ambiguous with real zero) to `undefined` (explicit "never nudged"). Backward compat: old persisted `0` loads as number, growth = currentTokens - 0 = huge → nudges once, then corrects.
- **Notification header**: Uses `tokensAfter = max(0, tokensBefore - compressedTokens + summaryTokens)`. Absolute only — no percentage or limit, prevents model from anchoring on ceiling.

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp && scripts/dev-deploy.sh --check
```

### Test Coverage

- New test files: `tests/inject-utils-pure.test.ts` (computeShouldNudge + resolveAdaptiveNudgeGrowth), `tests/acp-status.test.ts` (7 tests), `tests/inject.test.ts` (+3 integration tests)
- Test count: 523 total, 523 pass, 0 fail
- Key scenarios verified: adaptive scaling boundaries (10K→6K, 128K→6.4K, 200K→10K, 1M→50K, 2M→50K), post-compress state transitions, suffix gating, acp_status output format

### Results

- **PASS**: 523/523 tests, tsc clean, build 328KB

## 5. Risk Assessment & Rollback

- **Risk points**: Nudge frequency change affects all sessions — models may compress less often at high context levels. Monitor for under-compression.
- **Rollback method**: Revert to commit `d2a85b1` (v1.8.0). Or set explicit `nudgeGrowthTokens: 6000` in config to restore old behavior.
- **Compatibility notes**: Old persisted state with `lastPerMessageNudgeTokens: 0` will cause one extra nudge on first load, then self-corrects. No data migration needed.

## 6. Lessons Learned

- **Deploy ≠ Build**: Previous deploy script only copied dist/ without building. 4 commits were "deployed" but never in the bundle. New `dev-deploy.sh` always builds first.
- **Schema defaults can shadow code defaults**: `dcp.schema.json` had `nudgeGrowthTokens: 6000` as default — opencode framework applied it upstream of config.ts merge, making `resolveAdaptiveNudgeGrowth()` dead code.
- **0 is a bad sentinel**: Using `0` for "never happened" is ambiguous when 0 is a valid runtime value. `undefined` is explicit.

## 7. Follow-ups

- [ ] Consider tiering `buildContextUsageGuidance` text — at <55% context, show only token count without "precious"/"promptly" pressure words
- [ ] Merge PR #51 to master after verification
