# WORKLOG - toolOutput reminder must scale with context (5% protection bypass)

- Task ID: `2026-07-09_tooloutput-nudge-adaptive`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-09 11:05

## 1. Summary

- **What was done**: 
  1. Made the toolOutput accumulation reminder reuse the adaptive
  `nudgeGrowthTokens` threshold (5% of context, clamped [6K, 50K]) instead of a
  hardcoded 5000. Also wired the previously-dead `compress.toolOutputNudgeThreshold`
  config option through config merge, validation, and the JSON schema.
  2. Persisted `state.modelContextLimit` so adaptive thresholds (nudgeGrowthTokens,
  toolOutputThreshold) don't fall to the 6000 floor on the first turn after restart.
- **Why**: The hardcoded 5000 fired ~10× too often on large-context models,
  bypassing the 5% growth protection and driving severe over-compression (68
  compressions / 499 calls in the reported session, never above 22.6% context).
  The persistence fix completes (1): without it, `nudgeGrowthTokens` is undefined
  post-restart → 6K floor → the reminder still fires too often on turn 1 after reload.
- **Behavior / compatibility changes**: Yes — the toolOutput reminder now fires
  far less often on large-context models (intended). The `toolOutputNudgeThreshold`
  override is now actually honored (previously silently dropped). `modelContextLimit`
  is now persisted in state JSON (additive optional field, backward-compatible).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | fix: toolOutput reminder uses adaptive nudgeGrowthTokens (issue #18) |

### Key Files

- `lib/messages/inject/inject.ts` — line 204: `?? 5000` → `?? nudgeGrowthTokens`
  (the adaptive value, already computed at lines 173–174). Added a 2-line
  regression-prevention comment.
- `lib/config.ts` — `mergeCompress`: added
  `toolOutputNudgeThreshold: override.toolOutputNudgeThreshold,` so overrides
  flow through the merged config.
- `lib/config-validation.ts` — added `"compress.toolOutputNudgeThreshold"` to
  `VALID_CONFIG_KEYS` (no longer flagged as unknown).
- `dcp.schema.json` — declared `toolOutputNudgeThreshold` (number) next to
  `nudgeGrowthTokens`.
- `tests/inject.test.ts` — 3 new tests (no-fire on small growth / fire on large
  growth / override respected) + 2 new persistence tests (round-trip /
  ensureSessionInitialized restore).
- `tests/config-validation.test.ts` — 1 new test (key is valid).
- `lib/state/persistence.ts` — added `modelContextLimit?: number` to
  `PersistedSessionState`; save it in `saveSessionState`.
- `lib/state/state.ts` — restore `modelContextLimit` from persisted state in
  `ensureSessionInitialized` (after load, before the live system-prompt hook
  refreshes it).

## 3. Design & Implementation Notes

- **Entry point / key function**: `injectCompressNudges` in
  `lib/messages/inject/inject.ts`. The reminder logic at lines ~204–219 and the
  suffix injection at ~293–311.
- **Key configuration items**: `compress.toolOutputNudgeThreshold` (now live),
  `nudgeGrowthTokens` (adaptive: `NUDGE_GROWTH_RATIO=0.05` × modelContextLimit,
  clamped `[NUDGE_GROWTH_FLOOR=6000, NUDGE_GROWTH_CAP=50000]`).
- **Key logic**: The reminder fires when
  `toolGrowth >= toolOutputThreshold`, where `toolGrowth` is the change in tool
  tokens since `lastToolOutputNudgeTokens`. Previously `toolOutputThreshold`
  defaulted to a fixed 5000; now it defaults to `nudgeGrowthTokens` (50K on a
  1M model), aligning the two nudge mechanisms on the same 5% protection. The
  reminder still fires independently of `decision.shouldNudge` (so it can still
  surface heavy tool accumulation), but only at a context-proportional scale.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit — PASS (clean)
bun test tests/        # full suite (this env has no real Node, only Bun)
```

### Test Coverage

- New/modified test files: `tests/inject.test.ts` (+5), `tests/config-validation.test.ts` (+1).
- Test count: 591 baseline + 6 new = 597 expected on real Node.
- Key scenarios verified:
  - 1M model, ~9K tool growth → reminder does NOT fire (regression).
  - 1M model, ~64K tool growth → reminder DOES fire.
  - `toolOutputNudgeThreshold: 8000` override → fires at ~9K growth.
  - `modelContextLimit` survives save/load round-trip.
  - `ensureSessionInitialized` restores persisted `modelContextLimit` after restart.

### Results

- **typecheck**: PASS (clean).
- **bun test tests/inject.test.ts**: 19 pass / 0 fail (14 original + 5 new).
- **bun test tests/config-validation.test.ts**: 21 pass / 0 fail (20 + 1 new).
- **bun test tests/**: 593 pass / 1 fail. The single failure is a **pre-existing
  Bun-only limitation** (`prompts.test.ts:53` uses `test()` inside `test()`,
  which Bun's `node:test` compat does not support). It is unrelated to these
  changes and passes on real Node (CI). Confirmed: this change does not touch
  `prompts.test.ts`.

## 5. Risk Assessment & Rollback

- **Risk points**: Default behavior changes (reminder fires less often) — this
  is the intended fix; no data-format or API change.
- **Rollback method**: Revert the single commit.
- **Compatibility notes**: `toolOutputNudgeThreshold` was previously dead config;
  now it is live. Users who set it expecting it to work finally get the intended
  behavior. No persisted-state migration needed.

## 6. Lessons Learned

- **Adaptive scaling must be applied uniformly.** Commit `af2f2ac` (issue #9)
  introduced adaptive `nudgeGrowthTokens` AND the `toolOutputReminder` in the
  same change, but only carried the scaling over to the growth nudge. When two
  mechanisms gate the same action, they must share the same scale or one will
  silently subvert the other.
- **Dead config is a silent footgun.** A field declared in the type but absent
  from merge/validation/schema is indistinguishable from a working field to the
  user. The triple (type, merge, schema) should be kept in sync by construction.

## 7. Follow-ups (optional)

- [x] Persist `state.modelContextLimit` so the adaptive floor (6000) doesn't
      bite on first turn / after restart — **done in this PR** (originally
      listed as separate issue, folded in per user request on issue #18).

## 8. Systemic Regression Guard (added per user request on issue #18)

User asked for a test that catches the *class* of bug — any future change that
reverts a nudge mechanism to a fixed threshold. Added `inject.test.ts` test
"nudge thresholds scale with modelContextLimit — fixed thresholds must not
bypass 5% protection (#18 systemic guard)".

**Invariant tested**: the SAME tool growth (≈15K tokens) must fire the reminder
at a 200K context limit (15K > 10K threshold = 200K × 5%) but NOT at a 400K
limit (15K < 20K threshold). A fixed threshold (old `?? 5000`) fires at both →
test fails.

**Verified**: temporarily reverted `?? nudgeGrowthTokens` → `?? 5000` — the
guard correctly fails (alongside the existing instance tests). Restored → 20/20
pass.
