# REQ - Context-limit safety net never engages in spawn+resume mode (issue #346)

- Task ID: `2026-08-28_spawn-resume-context-limit`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: InProgress
- Priority: P0
- Owner: ranxianglei
- References: [issue #346](https://github.com/ranxianglei/opencode-acp/issues/346), [issue #312](https://github.com/ranxianglei/opencode-acp/issues/312) (preceding fix: model-limit catalog)

## 1. Background & Problem Statement

- **Context**: ACP's entire safety net (nudge anchors, emergency override,
  in-flight tool-output truncation, batch cleanup GC) is gated on
  `state.modelContextLimit`. Every percentage threshold
  (`compress.maxContextLimit`/`minContextLimit` = "80%",
  `compress.emergencyThresholdPercent` = "98%",
  `gc.majorGcThresholdPercent` = "100%") resolves to `undefined` when the limit
  is unknown, and every consumer treats `undefined` as "do nothing".
- **Root cause** (proven from two production sessions, plugin daily logs):
  in headless per-message spawn+resume mode (orchestrator spawns a fresh
  opencode process per message, resumes by session ID) the limit is never
  known at the time the messages-transform pipeline runs:
    1. Within one request the host fires `messages.transform` BEFORE
       `system.transform` (sst/opencode, confirmed in #312). The only writer of
       `state.modelContextLimit` is the system hook — so on the (only) request a
       spawned process handles, the limit is still `undefined` during all
       threshold math.
    2. The system hook never persists the limit it learns (`saveSessionState`
       only runs inside the messages-transform pipeline), so the next spawned
       process starts from `modelContextLimit: undefined` again. The limit is
       learned and lost, every message, forever.
    3. The catalog seed at plugin init (`hydrateModelLimitsFromClient`,
       fire-and-forget) races server readiness: the provider-config HTTP call
       can fail before the server is up, and nothing retries.
- **Current behavior (symptom)**: at 229,479 / 229,535 tokens (sglang qwen 27B,
  `max_model_len: 262144`) every transform logs
  `prePruneTokens == postTokens`, `nudged=false`; proactive compaction never
  fired (`lastCompaction: 0`). Total request size (context + ~15-20K system &
  tool schema + `max_tokens: 16384`) exceeds the serving window → immediate
  length rejection → opencode exits 0 with zero output → orchestrator retries
  the identical failing request forever.
- **Expected behavior**:
    1. The model context limit is known on the first request of a spawned
       process (persisted from the previous request's system hook, or lazily
       hydrated from the server during the request — the server is guaranteed up
       by then).
    2. When the limit is genuinely unknown, a configurable fallback limit bounds
       the conversation instead of disabling the safety net.
    3. In-flight tool-output truncation fires before the request hits the
       serving wall (limit minus system-prompt + output-token overhead), not at
       100% of the window.
    4. When the post-transform context still exceeds the model budget, ACP logs
       an ERROR (the exit-0 empty response is opencode-core behavior; the plugin
       cannot set the exit code).
- **Impact**: any headless spawn+resume deployment with a custom/direct
  provider whose limit is not resolvable from the init-time catalog is
  unbounded: guaranteed infinite retry loop at the length-rejection wall, no
  user-visible error.

## 2. Reproduction

- **Environment**: opencode 1.14.46 + opencode-acp v1.14.25, direct-to-sglang
  (qwen 27B, `max_model_len: 262144`, `max_tokens: 16384`), headless
  per-message spawn+resume, `acp.jsonc` containing only the `$schema` ref
  (all defaults).
- **Minimal reproduction steps**:
    1. Spawn opencode per message, resume by session ID; grow the conversation
       past 80% of the model window (or past the fallback limit).
    2. Observe `Chat transform complete` logs: `postTokens == prePruneTokens`,
       `nudged=false` at every size; no truncation, no batch cleanup.
    3. At ~229K tokens the request exceeds `max_model_len` → rejected → empty
       run, exit 0 → retry loop.
- **Relevant configuration**: all defaults. `gc.majorGcThresholdPercent:
"100%"` means in-flight truncation only starts at the full window — already
  past the serving wall once system prompt + tool schema + `max_tokens` are
  added.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: persisted state shape is additive only
      (modelContextLimit/identity already persisted); new config key
      `compress.contextLimitFallback` defaults to on; `0` restores legacy
      behavior. Internal `dcp` naming untouched.
    - No new dependencies. No `any`. Tests pass under
      `node --import tsx --test tests/*.test.ts`.
    - The messages-transform pipeline order is unchanged.
- **Non-Goals**:
    - Fixing opencode-core's exit-0 empty response (upstream issue candidate,
      reported separately).
    - Time-based nudge cadence / emergency-notification cadence changes.
    - Persisting the model's max-output-tokens limit (the 16K reserve constant
      covers the reported deployment; users with larger `max_tokens` can lower
      `gc.majorGcThresholdPercent`).

## 4. Acceptance Criteria

- **Correctness**:
    - [ ] The system hook persists `modelContextLimit` + model identity on
          change, so a freshly spawned process resumes with the limit known.
    - [ ] Internal-agent requests (title/summary/compaction) no longer overwrite
          the session limit with a different model's limit.
    - [ ] On a catalog miss during messages.transform, the catalog is hydrated
          once lazily (server is up during a request) before threshold math.
    - [ ] With an unknown limit, `compress.contextLimitFallback` (default 128000) drives nudge thresholds, emergency override, batch cleanup,
          and in-flight truncation; `0` disables the fallback.
    - [ ] In-flight truncation threshold = `min(gc.majorGcThresholdPercent ×
    limit, limit − systemPromptTokens − 16384)`; production numbers
          (limit 262144, system ~17K, 229479 tokens) now trigger truncation.
    - [ ] Post-transform tokens above the model budget log an ERROR with the
          budget breakdown.
- **Performance / Stability**:
    - [ ] No new per-request HTTP calls on the common path (lazy hydration at
          most once per process; persistence only on change).
- **Regression**:
    - [ ] New tests cover: limit persistence, lazy hydration, fallback
          thresholds, overhead-aware truncation (production repro), hard-guard
          error log. Each verified to FAIL against the pre-fix code.
    - [ ] Full suite passes.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/hooks.ts` — system hook: move limit write after internal-agent
      check, persist on change; messages transform: lazy hydration, effective
      limit in filter ctx + logs, hard-guard ERROR.
    - `lib/state/state.ts` — `SessionStateRegistry.hydrateAndResolve()` (lazy
      one-shot hydration).
    - `lib/state/utils.ts` — `resolveEffectiveContextLimit(state, config)`
      helper (`model` | `fallback` source).
    - `lib/config.ts` + `lib/config-validation.ts` + `dcp.schema.json` — new
      `compress.contextLimitFallback` (number, default 128000, 0 = off).
    - `lib/messages/inject/utils.ts` — `resolveContextTokenLimit` /
      `isContextOverLimits` use the effective limit.
    - `lib/gc/merge.ts` — `runBatchCleanup` uses the effective limit.
    - `lib/messages/truncate-tools.ts` — `OUTPUT_RESERVE_TOKENS = 16384`,
      overhead-aware threshold.
    - Docs: CONFIGURATION.md (+ zh-CN), devlog.
- **Risks**: fallback default (128K) makes unknown-limit sessions compress
  earlier than "never" — intended; disable with `contextLimitFallback: 0`.
  Persisting the limit adds one small write on model/limit change only.
- **Rollback strategy**: revert the PR; state files remain compatible (new
  fields are ignored by older versions).
