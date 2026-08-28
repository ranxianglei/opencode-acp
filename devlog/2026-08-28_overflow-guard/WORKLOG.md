# WORKLOG - Request-side overflow guard + uncalibrated-window WARN

- Task ID: `2026-08-28_overflow-guard`
- Home Repo: `opencode-acp`
- Status: InReview
- Updated: 2026-08-29

## 1. Summary

- **What was done** (1–3 sentences): Added a request-side hard guard
  (`pruneToFit`) that deterministically clears the oldest compressible
  (non-protected) tool outputs when the estimated wire size exceeds
  `knownWindow - overflowGuardReserve`, and a one-time per-session WARN
  (`trackUncalibratedWindow`) that surfaces the uncalibrated-window blindness.
- **Why** (1–3 sentences): When a model reports `limit.context = 0`, ACP's
  percentage thresholds silently no-op and the session dies on a swallowed provider
  400 (#347). The guard makes the request fit without model cooperation; the WARN
  makes the blindness visible and actionable.
- **Behavior / compatibility changes**: Yes — additive. New config knobs
  `compress.overflowGuard` (default true) and `compress.overflowGuardReserve`
  (default 32768); two transient (non-persisted) state fields. When the guard fires,
  old tool outputs are replaced with a placeholder (the tool can be re-run).
- **Risk level**: Medium (clears tool outputs in an overflow emergency; gated by an
  enable flag and only fires when over a known budget).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| tip of `2026-08-28_overflow-guard` | feat: request-side overflow guard + uncalibrated-window WARN (#347) |

### Review Round 1 (dual-agent)

- **Blocking (fixed)** — B1: `estimateWireTokens` read only the last assistant's
  provider-reported usage, which is the context size *after* the last LLM call and so
  omits tool outputs appended *after* that call. A mid-turn sub-request (opencode runs
  messages.transform on every LLM call) could therefore be under-estimated by the size
  of a freshly-completed tool output and still 400. Fix: add the last assistant's
  trailing completed tool outputs to the estimate (conservative — exact when the last
  step has text, over-counts only for tool-calls-only steps, the safe direction).
  Regression test added and verified to fail without the fix.
- **Non-blocking (fixed)**: the "recent-message protection zone" test was vacuous
  (the gap stopped the guard before the zone, so it passed even with
  `computeProtectedRefs` removed) — reworked so the gap forces the guard into the zone
  and asserts the zone-protected message is skipped while an ERROR is logged. Added a
  production-shape test (last assistant message carrying a trailing completed tool part)
  covering current-turn protection. Added an ERROR log for the "over budget but nothing
  clearable" case (previously a silent no-op). Added a test pinning an explicit
  `overflowGuardReserve: 0` (nullish, not falsy).
- **Non-blocking (kept as-is, with rationale)**: the test keeps a local copy of
  `CLEAR_PLACEHOLDER` rather than importing it — importing would make the assertion
  tautological; the local copy catches source drift.

### Key Files

- `lib/messages/prune-to-fit.ts` — **new**. `pruneToFit` (the guard) +
  `resolveKnownWindow` (window resolution). Clears oldest non-protected tool outputs
  until the estimate fits.
- `lib/messages/uncalibrated-window.ts` — **new**. `trackUncalibratedWindow` (Fix 1
  WARN) + `UNCALIBRATED_WINDOW_WARN_THRESHOLD` (3).
- `lib/hooks.ts` — import + call `trackUncalibratedWindow` (after
  `updatePerTurnState`) and `pruneToFit` (after `truncateLargeToolOutputs`).
- `lib/config.ts` — `CompressConfig` + `DEFAULT_CONFIG` + `mergeCompress`: new
  `overflowGuard` / `overflowGuardReserve`.
- `lib/config-validation.ts` — `VALID_CONFIG_KEYS` + type validation for the two knobs.
- `dcp.schema.json` — schema entries + defaults for the two knobs.
- `lib/state/types.ts`, `lib/state/state.ts` — transient fields
  `uncalibratedWindowTransforms` / `uncalibratedWindowWarned` (init + reset).
- `lib/messages/index.ts` — barrel exports for both new modules.
- `tests/prune-to-fit.test.ts` — **new**, 28 tests.

## 3. Design & Implementation Notes

- **Entry point / key function**: `pruneToFit(state, config, logger, messages)` in
  `lib/messages/prune-to-fit.ts`; `trackUncalibratedWindow(state, logger)` in
  `lib/messages/uncalibrated-window.ts`.
- **Key configuration items**:
  - `compress.overflowGuard` (bool, default `true`) — enable the guard.
  - `compress.overflowGuardReserve` (number, default `32768`) — completion reserve.
- **Key logic explanation** (if non-trivial):
  - `resolveKnownWindow` returns `modelContextLimit` (the real window) when set, else
    the absolute `modelMaxLimits[provider/model]`, else the absolute
    `maxContextLimit`; `undefined` when only a percent is configured (a percent is a
    nudge threshold, not a window — using it would massively over-prune).
   - Estimate = `getCurrentTokenUsage` (O(1) provider usage) + the last assistant's
     trailing completed tool outputs (appended after the last LLM call, so absent from
     the provider usage — review finding B1) + `WIRE_SAFETY_MARGIN` (8192) to cover the
     new user message + nudges; precise count only when there's no provider token data.
  - The guard iterates oldest→newest, skipping the current turn, user messages, the
    recent-message protection zone (`computeProtectedRefs`), protected tools, and
    protected file paths (Bug 39 parity). It clears a tool output by setting
    `part.state.output` to a placeholder, tracking freed tokens, and stopping once the
    estimate fits. Logs WARN on success, ERROR if it clears everything but still
    exceeds the window.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build
npm run typecheck
node --import tsx --test tests/prune-to-fit.test.ts
node --import tsx --test tests/*.test.ts
```

### Test Coverage

- New/modified test files: `tests/prune-to-fit.test.ts` (new, 28 tests).
- Test count: 1057 total, 1057 pass, 0 fail (full suite).
- Key scenarios verified:
  - `resolveKnownWindow`: model limit wins; per-model absolute fallback; global
    absolute fallback; per-model precedence; percent → undefined; nothing → undefined.
  - `pruneToFit`: no-op under budget; fire + oldest-first + stop-when-fit; clears
    multiple for a large gap (never the last); skips protected tools; skips protected
    file paths; idempotent on already-cleared; no-op when disabled; no-op with no
    known window; fires via absolute `maxContextLimit`; no-op when `safeBudget <= 0`;
     respects the recent-message protection zone (gap forced into the zone); no crash
     on empty/no-tool input; logs WARN on fit, ERROR when it cannot fit, and ERROR when
     over budget but nothing is clearable; counts trailing tool outputs appended after
     the last LLM call (B1 regression — verified to fail without the fix); does not
     clear the current turn's trailing tool output; respects an explicit
     `overflowGuardReserve: 0` (nullish, not falsy).
  - `trackUncalibratedWindow`: warns once at threshold; never warns when calibrated;
    dedup across many transforms; counter resets on calibration then re-climbs;
    multi-turn accumulation.

### Results

- **PASS/FAIL**: PASS (typecheck clean, build clean, 1057/1057 tests pass).
- **Key logs/data**: n/a (unit-level).

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Over-pruning when the user sets `maxContextLimit` well below the real window
    (mitigated: the user controls the declared budget; documented).
  - Clearing a tool output loses it until re-run (intentional, last-resort; the model
    sees a descriptive placeholder).
- **Rollback method**:
  - Revert commit(s): the tip commit of `2026-08-28_overflow-guard`
  - Or set `compress.overflowGuard: false` to disable the guard at runtime.
  - Rollback impact: none (additive change).
- **Compatibility notes** (data format, config schema): Additive only. Two new config
  keys (validated + schema'd); two new transient state fields (not persisted, so old
  state files load unchanged). No internal `dcp` tag changes.

## 6. Lessons Learned (optional)

- The `#312` catalog reconciliation and the system-hook writer *both* guard on
  `limit.context`, so a `limit.context = 0` model is blind at two independent points —
  a fix must account for both (the catalog miss is why the WARN counter only climbs
  for genuinely uncalibrated models, not for the first-request race).
- `truncateLargeToolOutputs` already had the same blindness (`if (!modelContextLimit)
  return`) — the new guard deliberately does *not* gate on `modelContextLimit` so it
  works via the absolute `maxContextLimit` fallback.

## 7. Follow-ups (optional)

- [ ] Once opencode exposes a response-error hook to plugins, add "learn the window
      from 400s" (issue #347 Fix 3) so the guard works with zero configuration.
- [ ] File upstream opencode issues: exit-0-on-400 (no error surfaced) and
      `options.maxTokens` not honored (leaks as a raw `maxTokens` body key).
