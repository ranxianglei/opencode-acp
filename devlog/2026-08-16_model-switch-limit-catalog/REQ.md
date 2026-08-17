# REQ - Fix wrong context-level math after model switch (issue #312)

- Task ID: `2026-08-16_model-switch-limit-catalog`
- Home Repo: `opencode-acp`
- Created: 2026-08-16
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: [issue #312](https://github.com/ranxianglei/opencode-acp/issues/312)

## 1. Background & Problem Statement

- **Context**: `state.modelContextLimit` is written exclusively by the
  `experimental.chat.system.transform` hook (lib/hooks.ts). Every percentage
  threshold derives from it: `compress.emergencyThresholdPercent`,
  `compress.min/maxContextLimit` in `"N%"` form, adaptive `nudgeGrowthTokens`
  (5% of limit clamped [6K, 50K]), GC tier thresholds, and
  `buildCompressedBlockGuidance` context hints.
- **Root cause** (host-source-confirmed, sst/opencode dev HEAD): within one LLM
  request the host fires `experimental.chat.messages.transform` FIRST
  (packages/opencode/src/session/prompt.ts:1255, before `handle.process`) and
  `experimental.chat.system.transform` SECOND
  (packages/opencode/src/session/llm/request.ts:69-73, inside `prepare()` under
  `handle.process`). The messages hook runs all nudge/threshold math BEFORE the
  system hook writes the new model's limit.
- **Current behavior (symptom)**: switch mid-session from a 200K model to a 1M
  model with `emergencyThresholdPercent: "50%"` → the first request(s) after the
  switch compute the threshold as 50% × 200K = 100K. At ~260K actual context the
  user is told the context is at "emergency" while it is really at 26% of the 1M
  window. Conversely, switching 1M → 200K misses a real emergency until the
  system hook catches up on the following request.
- **Expected behavior**: threshold math on the FIRST request after a model
  switch uses the new model's context window.
- **Impact**: premature (or missed) emergency compression nudges, distorted
  adaptive nudge growth, wrong GC tier evaluation for one request after every
  model switch.

## 2. Reproduction

- **Minimal reproduction steps**:
  1) Use a session on a 200K-context model; let `state.modelContextLimit = 200000`.
  2) Set `compress.emergencyThresholdPercent: "50%"`.
  3) Switch the model to a 1M-context model; send a message bringing context to ~260K.
  4) First request after the switch: emergency nudge "Context limit reached" fires
     (260K ≥ 0.5 × 200K stale limit) even though usage is 26% of 1M.
- **Relevant configuration**: `compress.emergencyThresholdPercent: "50%"`; any
  model switch between different context windows (user report: 20w → 100w).

## 3. Constraints & Non-Goals

- **Non-Goals**: changing host dispatch order; persisting per-model limits to
  disk; changing `modelContextLimit` semantics for same-model requests.
- **Constraints**: no `any` (repo lint rule); no new dependencies; tests must
  pass under `node --import tsx --test tests/*.test.ts`.

## 4. Acceptance Criteria

- [x] First request after a model switch resolves the new model's context limit
      before any threshold math runs.
- [x] Unknown model (no catalog entry) falls back to previous behavior (stale
      limit for one request, corrected by system hook later in that request).
- [x] Catalog populated both live (per request via system hook) and at plugin
      init (GET /config/providers).
- [x] All existing tests pass (988 pass, 0 fail) + new regression tests.

## 5. Proposed Approach

`SessionStateRegistry` gains a `${providerID}/${modelID}` → context-limit
catalog. The system hook records every observed model's limit into it
(statelessly, before the session-state guard). The messages hook, right after
resolving the session state, reconciles `state.modelContextLimit` from the
catalog entry for the model named on the request's last user message. At plugin
init the catalog is seeded best-effort from `client.config.providers()`
(returns all providers + models with `limit.context`).
