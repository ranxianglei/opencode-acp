# WORKLOG - Context Budget Guard + No-Window Warning

- Task ID: `2026-08-28_context-budget-guard`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-28 23:50

## 1. Summary

- **What was done** (1–3 sentences):
  Added a deterministic prune-to-fit guard (`enforceContextBudget`) to the
  `messages.transform` pipeline and a once-per-session loud warning for models
  that report no context window. Fixes ranxianglei/opencode-acp#347
  (billion-context#317): sessions whose input grew past the backend's real
  window were rejected with HTTP 400, which opencode swallows as an empty
  exit-0 response, permanently stumping the session with no error surface.
- **Why** (1–3 sentences):
  When a custom model has no `limit` entry, `modelContextLimit` stays
  undefined and every percentage threshold (min/max/emergency, GC) is
  disabled; only advisory nudges remain, so input grows unbounded until the
  backend 400s (230,527 input + 32,000 completion > 262,144 window in the
  production case). The guard makes the known-window path deterministic; the
  warning makes the unknown-window path loud and actionable.
- **Behavior / compatibility changes**: Yes — additive. With a known model
  window, requests estimated above `window - completionReserveTokens` (default
  32,768) now have old compressible tool outputs truncated/cleared until they
  fit (after the existing GC truncation). With an unknown window, a one-time
  WARN with config guidance is logged. No persisted-state schema change
  (`noContextLimitWarned` is transient).
- **Risk level**: Low — guard only prunes tool outputs already classified
  compressible (same protections as `truncateLargeToolOutputs`), never user
  text or summaries; all changes additive; full suite green.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `62976d4` | fix: context budget guard + no-window warning (#347) |

### Key Files

- `lib/messages/enforce-budget.ts` — new: `resolveContextWindow` (model
  window only), `estimateWireTokens`, `enforceContextBudget` (phase 1
  truncate largest old tool outputs, phase 2 clear oldest to placeholder).
- `lib/hooks.ts` — guard call after `truncateLargeToolOutputs` in
  `messages.transform`; warn-once after model-limit reconciliation.
- `lib/config.ts` — new optional `compress.completionReserveTokens`
  (default applied at the consumer, `DEFAULT_COMPLETION_RESERVE_TOKENS`).
- `lib/state/types.ts`, `lib/state/state.ts` — transient
  `noContextLimitWarned` flag (default/reset false, not persisted).
- `dcp.schema.json`, `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` — docs for
  `completionReserveTokens`.
- `tests/enforce-budget.test.ts` — new: 14 tests covering window resolution,
  estimation, no-op paths, phase 1/2 pruning, protections, idempotency,
  over-budget warning.

## 3. Design & Implementation Notes

- **Entry point / key function**:
  `enforceContextBudget(state, config, logger, messages)` in
  `lib/messages/enforce-budget.ts`, called from `createChatMessageTransformHandler`
  in `lib/hooks.ts` right after `truncateLargeToolOutputs`.
- **Key configuration items**:
  - `compress.completionReserveTokens` (number, default 32768) — reserved for
    the completion; covers opencode's 32,000 `max_tokens` fallback when
    `limit.output` is 0/unknown.
- **Key logic explanation**:
  - Window resolution uses ONLY `state.modelContextLimit`. An absolute
    `compress.maxContextLimit` is deliberately NOT a fallback: it is a soft
    nudge/compression threshold, not the backend's real limit. Pruning to a
    guessed threshold destroys context the backend would accept and starves
    the nudge of its compressible targets (regressed
    e2e-blocks-nudges "compressible ranges injected into suffix message when
    shouldNudge fires" during development: guard pruned the one large tool
    output below the recommendation floor → `nothingToCompress` → no suffix).
    Users with an unknown window get the loud one-time warning instead.
  - Estimation: last assistant's reported usage (input + cacheRead +
    cacheWrite + output + reasoning) + tokens of messages after it; fallback
    (no assistant token data) = full content estimate + cached system prompt
    tokens.
  - Protections (same as `truncateLargeToolOutputs` plus): first user message,
    last 3 messages, `protectedTools`, compress-tool outputs (summaries),
    already-cleared outputs. Truncation reuses the same marker
    (`[truncated for context space`) so the two mechanisms are idempotent
    together.
  - Same-turn caveat: after pruning, the estimate stays stale until the next
    turn (assistant-reported usage); a re-run finds no candidates and logs a
    "still over budget" warning — self-corrects on the next turn when the
    model reports the shrunken input.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run specific test file
node --import tsx --test tests/enforce-budget.test.ts

# Type check
npx tsc --noEmit
```

### Results

- `npm run typecheck` — clean.
- `npm test` — 1043/1043 pass (14 new in `tests/enforce-budget.test.ts`).
- `npm run build` — success (dist/index.js 419.61 KB).
- Regression check: `tests/e2e-blocks-nudges.test.ts` 10/10 (was failing
  during development while the guard used the absolute `maxContextLimit` as a
  window; fixed by restricting the guard to the model-reported window).
