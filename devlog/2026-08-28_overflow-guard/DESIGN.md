# DESIGN - Request-side overflow guard + uncalibrated-window WARN

- Task ID: `2026-08-28_overflow-guard`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** When a model reports `limit.context = 0`, ACP's
  `state.modelContextLimit` is never set, so every percentage threshold resolves to
  `undefined` and silently no-ops. The session then grows past the backend's real
  window and dies on a provider 400 that opencode swallows (exit 0, no output) — a
  silent, deterministic, unrecoverable death loop.
- **Why now?** Reported in #347 with a concrete, reproducible production failure
  (sglang qwen3.8-27b, real window 262,144). It affects *every* custom provider
  without a catalog entry.

## 2. Goals & Non-Goals

- **Goals**:
  - Make the uncalibrated-window blindness *visible* (one-time WARN per session).
  - Add a *request-side hard guard* that deterministically keeps the outgoing
    request within the known window, independent of model cooperation.
- **Non-Goals**:
  - Fixing opencode's exit-0-on-400 / maxTokens bugs (upstream).
  - Learning the window from 400s (blocked — no response-error hook for plugins).

## 3. Current Architecture

- `createSystemPromptHandler` (hooks.ts) is the only writer of
  `state.modelContextLimit`; it guards on `input.model?.limit?.context`, so a model
  reporting `0` never sets it. The `#312` catalog reconciliation in
  `createChatMessageTransformHandler` also misses (catalog drops `limit <= 0`).
- All percentage consumers (`parseLimitValue` in `inject/utils.ts`) return
  `undefined` when `modelContextLimit` is `undefined`.
- `truncateLargeToolOutputs` (truncate-tools.ts) is the only existing space-freer,
  but it returns early `if (!state.modelContextLimit)` — i.e. it is *also* blind to
  the exact case we care about.

## 4. Proposed Architecture

```
messages.transform (createChatMessageTransformHandler)
  │
  ├─ reconcile modelContextLimit from catalog (#312)
  ├─ updatePerTurnState
  ├─ trackUncalibratedWindow(state, logger)          [FIX 1 — new]
  │     └─ if modelContextLimit undefined N turns → one-time WARN
  │
  ├─ prune → truncateLargeToolOutputs
  ├─ pruneToFit(state, config, logger, messages)     [FIX 2 — new]
  │     ├─ knownWindow = resolveKnownWindow(...)
  │     │     = modelContextLimit ?? abs modelMaxLimits[p/m] ?? abs maxContextLimit
  │     ├─ safeBudget = knownWindow - overflowGuardReserve
  │     ├─ estimate = getCurrentTokenUsage + WIRE_SAFETY_MARGIN  (O(1))
  │     └─ if estimate > safeBudget: clear oldest non-protected tool outputs
  │           (skip protected tools/paths, current turn, user msgs, recent zone)
  │           until estimate - freed <= safeBudget
  └─ ... (nudge injection, id injection, etc.)
```

- **Key components**:
  - `pruneToFit` / `resolveKnownWindow` (`lib/messages/prune-to-fit.ts`).
  - `trackUncalibratedWindow` (`lib/messages/uncalibrated-window.ts`).
- **Data flow**: The guard mutates tool parts' `state.output` in place (same
  mechanism as `truncateLargeToolOutputs`), so the change applies to the outgoing
  request. It is idempotent (already-cleared outputs are skipped).
- **API / interface changes**: Two new config knobs; two new *transient* (non-
  persisted) `SessionState` fields; two new exported functions.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Where to guard | (a) rely on nudges (model-driven); (b) request-side hard guard | (b) | Nudges are advisory and the model may not comply; a hard 400 needs a deterministic, model-independent fix. |
| `knownWindow` source | (a) `modelContextLimit` only; (b) also absolute `maxContextLimit` | (b) | Lets the guard protect users who declare an absolute budget even when the model reports no window. Percent values are *not* used as the window (they'd be the nudge threshold, not the real window → massive over-prune). |
| Completion reserve | (a) store `limit.output` in state; (b) fixed config knob | (b) `overflowGuardReserve` (default 32768) | Avoids state churn + model-switch staleness; 32768 covers opencode's 32000 fallback for `limit.output = 0`. User can tune down for small-output models. |
| Wire-size estimate | (a) always precise count; (b) O(1) provider usage + margin, precise only as fallback | (b) | The precise count is O(total tokens); running it every well-under-budget turn is wasteful. `getCurrentTokenUsage` is O(1) and accurate to within the new-user-message delta, covered by `WIRE_SAFETY_MARGIN = 8192`. |
| What to free | (a) truncate (prefix+suffix); (b) clear entirely | (b) | In an overflow emergency, freeing maximum space is the priority; the model can re-run the tool. `truncateLargeToolOutputs` already handles the gentler truncation at the GC threshold. |
| WARN mechanism | (a) inline in handler; (b) extracted pure fn | (b) `trackUncalibratedWindow` | Testable in isolation; keeps the handler lean. Threshold 3 rules out the first-request race (system.transform runs after messages.transform). |

## 6. Impact Analysis

- **Backward compatibility**: Additive only. Two new config knobs (sensible defaults),
  two new transient state fields (not persisted — old state files load fine; they
  default to `0`/`false`), two new exports. No persisted-format or internal-tag change.
- **Performance**: No-op (O(1) check) when under budget. Precise tokenization only on
  the first turn without provider token data.
- **Security**: None.
- **Dependencies**: None new.

## 7. Migration Plan

- **Steps**:
  1) Ship with `overflowGuard: true` by default.
  2) Users on custom providers see the one-time WARN and are told exactly what to
     configure (`limit` in opencode.json or absolute `compress.maxContextLimit`).
- **Feature flags / gradual rollout**: `compress.overflowGuard: false` disables the
  guard entirely (the WARN still fires, which is desirable).

## 8. Open Questions

- [ ] Should the guard also truncate (not just clear) as an intermediate step before
      clearing entirely? (Deferred — clearing is the effective last resort; the
      existing `truncateLargeToolOutputs` covers the gentler case.)
- [ ] Once opencode exposes a response-error hook, add "learn the window from 400s"
      (issue Fix 3) to make the guard work with zero configuration.
