# DESIGN - Context-limit safety net for spawn+resume mode (issue #346)

- Task ID: `2026-08-28_spawn-resume-context-limit`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?**
  ACP's safety net (nudge anchors, emergency override, batch-cleanup GC,
  in-flight tool-output truncation) is gated on `state.modelContextLimit`. In
  headless per-message spawn+resume mode the limit was never known when the
  messages-transform pipeline ran, so every percentage threshold resolved to
  `undefined` and the safety net was silently disabled. Sessions grew to the
  serving wall (~229K tokens on a 262144 window + ~17K system + 16K
  `max_tokens`) and entered an infinite empty-response retry loop (exit 0, no
  error).
- **Why now?** Two production sessions froze at the wall with plugin logs
  proving `postTokens == prePruneTokens` and `nudged=false` at every size.

## 2. Goals & Non-Goals

- **Goals**:
    - The limit is known on the first request of a spawned process.
    - A configurable fallback window bounds the conversation when the limit is
      genuinely unknown.
    - In-flight truncation fires before the serving wall (overhead-aware).
    - A loud ERROR when the post-transform context still exceeds the budget.
- **Non-Goals**:
    - Changing opencode-core's exit-0 empty response (upstream issue).
    - Persisting the model's max-output-tokens limit (constant reserve +
      `gc.majorGcThresholdPercent` escape hatch instead).
    - Changing the messages-transform pipeline order.

## 3. Current Architecture (if applicable)

- **How it works today**:
    - `state.modelContextLimit` is written only by the system-prompt hook
      (`lib/hooks.ts`), which runs AFTER the messages-transform within one
      request — and it is never persisted (saves happen inside the
      messages-transform pipeline, before the system hook of the same request).
    - The model-limit catalog (`lib/state/model-limits.ts`) is seeded at plugin
      init via a fire-and-forget `client.config.providers()` call that races
      server readiness in spawned processes.
    - `resolveContextTokenLimit` (`lib/messages/inject/utils.ts`) returns
      `undefined` for percentage thresholds when `state.modelContextLimit` is
      `undefined`; `isContextOverLimits` then reports no limit crossed; anchor
      sets stay empty; `runBatchCleanup` and `truncateLargeToolOutputs` early
      return.
- **Pain points**: limit learned and lost per request; no retry on init-time
  hydration failure; truncation threshold at 100% of the window ignores the
  system prompt + `max_tokens` overhead.

## 4. Proposed Architecture

- **Overview**:
    ```
    system.transform (per request)
        └─ learn limit → if changed: saveSessionState (NEW)
    messages.transform (per request)
        ├─ catalog resolve (existing #312 reconciliation)
        │    └─ miss → registry.hydrateAndResolve: ONE lazy hydration/process (NEW)
        ├─ effective limit = model limit ?? compress.contextLimitFallback (NEW helper)
        ├─ nudge thresholds / emergency override / GC / truncation use effective limit
        └─ post-transform: if postTokens > limit − systemPromptTokens − 16384
               → logger.error("ACP hard guard: ...") (NEW)
    ```
- **Key components**:
    - `SessionStateRegistry.hydrateAndResolve(client, providerId, modelId)` —
      resolve; on miss, hydrate from the client once per process, re-resolve.
    - `resolveEffectiveContextLimit(state, config): {limit, source:
"model"|"fallback"} | undefined` — single source of truth for the window.
    - `compress.contextLimitFallback` (default 128000, `0` disables).
    - `OUTPUT_RESERVE_TOKENS = 16384` (`lib/messages/truncate-tools.ts`).
- **Data flow**:
    - Limit lifecycle: system hook → state file (persisted on change) → next
      process's `ensureSessionInitialized` (already restored) → threshold math.
      Fallback chain: persisted/learned model limit → catalog (init seed or
      lazy hydration) → `contextLimitFallback` → `undefined` (legacy no-op).
- **API / interface changes**:
    - New config key `compress.contextLimitFallback` (validated, schema'd,
      documented).
    - New registry method `hydrateAndResolve`.
    - New export `resolveEffectiveContextLimit` + `EffectiveContextLimit`.
    - New export `OUTPUT_RESERVE_TOKENS`.
    - Persisted state shape: unchanged (fields already existed).

## 5. Design Decisions & Rationale

| Decision                    | Options Considered                                                                   | Chosen                    | Why                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where to persist the limit  | (a) system hook saves on change; (b) messages transform re-derives from catalog only | (a)                       | The system hook is the only place the host tells us the real limit; saving on change is cheap (one file write per model/limit change, not per request).                                                                        |
| Init-time hydration retry   | (a) retry loop at init; (b) lazy one-shot hydration during a request                 | (b)                       | During a request the server is guaranteed up (we are inside its pipeline); one retry per process avoids repeated HTTP calls; the fallback covers the still-unknown case.                                                       |
| Unknown-limit behavior      | (a) keep legacy no-op; (b) new fallback key, default on                              | (b) with `0` escape hatch | The issue's core complaint is "the safety net never engages"; a conservative 128K default bounds sessions while `0` restores legacy behavior for anyone who relied on it.                                                      |
| Truncation threshold        | (a) keep 100% of window; (b) `min(configured, limit − systemPromptTokens − 16384)`   | (b)                       | The serving wall includes system prompt + tool schemas + `max_tokens`; 100% of the window is already past it (the production failure). `min()` keeps `gc.majorGcThresholdPercent` as the user escape hatch for larger outputs. |
| Overflow signaling          | (a) throw/abort from the plugin; (b) loud ERROR log                                  | (b)                       | Plugins cannot set the process exit code or reject the request; an ERROR in the daily log gives the operator/orchestrator a greppable signal. Exit-0 empty response is filed upstream.                                         |
| Internal-agent limit writes | (a) write before signature check (status quo); (b) skip internal agents              | (b)                       | Title/summary/compaction agents run on their own small model; their limit must not corrupt the session's real limit (would shrink every threshold).                                                                            |

## 6. Impact Analysis

- **Backward compatibility**:
    - State file: additive only (fields pre-existed).
    - Config: new key defaults on; `contextLimitFallback: 0` restores the exact
      legacy behavior.
    - Sessions with a known model limit: unchanged (model limit always
      precedence).
    - Sessions with an unknown limit: previously unbounded, now bounded by the
      fallback window (intended behavior change).
- **Performance**: at most one extra `client.config.providers()` call per
  process (and only on a catalog miss); one extra state save per limit change.
  No new per-request work on the common path.
- **Security**: none (no new external input handling).
- **Dependencies**: none.

## 7. Migration Plan (if applicable)

- **Steps**:
    1. Ship with the fallback default ON (128000).
    2. Operators of very large-window custom providers who want the legacy
       "no safety net until learned" behavior set
       `"compress": { "contextLimitFallback": 0 }`.
    3. Operators whose `max_tokens` exceeds 16K lower
       `gc.majorGcThresholdPercent` (e.g. `"85%"`).
- **Feature flags / gradual rollout**: `contextLimitFallback: 0` is the
  rollback switch; no flag needed beyond it.
