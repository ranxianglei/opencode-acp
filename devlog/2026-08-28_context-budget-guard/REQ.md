# REQ - Context budget guard + no-window warning

- Task ID: `2026-08-28_context-budget-guard`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: InProgress
- Priority: P1
- Owner: ework-daemon (agent)
- References: ranxianglei/billion-context#317, ranxianglei/opencode-acp#347

## 1. Background & Problem Statement

- **Context**: Production incident (billion-context#317): long-lived headless sessions
  (per-message resume via `opencode run --session <id>`) fail fast on resume — model
  process exits in ~5s with code 0 and no output, every retry reproduces, fresh session
  works. Two cases: 230,529 and 37,178 `totalPruneTokens`, both `lastCompaction: 0`.
- **Current behavior (symptom)**: For a custom model with no declared context window
  (opencode `/config/providers` reports `limit: {context: 0, output: 0}`), the plugin
  never learns `modelContextLimit`. All percentage thresholds (min/max/emergency, GC)
  silently disable, the only surviving protection (advisory 50K-growth nudge) is
  model-cooperative, and opencode's `max_tokens` fallback (32,000 when `limit.output`
  is unknown) is not accounted for. The request grows until the model backend rejects
  it with HTTP 400 ("Requested token count exceeds the model's maximum context length
  of 262144 tokens. You requested a total of 262527 tokens: 230527 tokens from the
  input messages and 32000 tokens for the completion"). opencode swallows the 400:
  `session.error` bus event, idle, exit 0, no output — the session is permanently
  stuck (context only grows across retries).
- **Expected behavior**:
  1. When the model reports no context window and the catalog has no entry for it,
     surface a loud, actionable warning (once per session) instead of failing blind.
  2. When the model reports a context window, never send a request whose estimated
     input exceeds `window - completionReserve` — deterministically prune compressible
     tool outputs (truncate to prefix+suffix, then clear oldest) until the request
     fits. The guard ONLY enforces the model-reported window: an absolute
     `compress.maxContextLimit` is a soft nudge threshold, not the backend's real
     limit, and pruning to it would destroy context the backend would accept.
- **Impact**: Any deployment with a custom/self-hosted model lacking a `limit` entry
  (sglang/vLLM local backends are the common case) with long sessions. Permanent
  session loss (only a fresh session id recovers), no error surface for the user.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22+ (plugin runtime; opencode 1.14.x host)
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1) Configure a custom model with no `limit` (e.g. sglang qwen via `vllm-qwen`
     provider, `options.maxTokens` set but no `limit.context`).
  2) Run a long session where the model calls `compress` repeatedly so
     `totalPruneTokens` grows (advisory nudges only, no hard gate).
  3) Resume with `opencode run --session <id> "..."` once estimated input +
     max_tokens (32,000 fallback) exceeds the backend's real window (262,144).
  4) Observe: 400 from backend, opencode exits 0 with no output, retries loop.
- **Relevant configuration**:
  - `~/.config/opencode/opencode.json`: model without `limit`; `compaction.auto: false`.
  - `acp.jsonc`: no absolute `compress.maxContextLimit` (percentages disabled).
- **Workaround (verified)**: add `"limit": {"context": 262144, "output": 16384}` to
  the model definition in opencode.json (this is what enables the guard —
  `modelContextLimit` becomes known); optionally an absolute
  `compress.maxContextLimit` in acp.jsonc to make the advisory nudges proactive
  (soft threshold only — the guard does not use it).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: fully additive. Default behavior with a known model window
    is unchanged (guard budget = window - reserve; existing GC truncation still runs
    first). No persisted-state schema change (`noContextLimitWarned` is transient).
  - Performance requirements: estimation reuses the existing Anthropic tokenizer path
    (`getCurrentTokenUsage` + `countAllMessageTokens`); pruning loop only runs when
    over budget.
  - Resource limits: must never touch summaries (compress tool outputs), protected
    tools, the first user message, or the last 3 messages (same protections as
    `truncateLargeToolOutputs`).
- **Non-Goals** (explicitly out of scope):
  - Fixing opencode's exit-0-on-400 (upstream issue; body drafted in #317).
  - Learning the window from a 400 response (no plugin hook exposes response errors;
    tracked as design note in #347).
  - Changing nudge/GC trigger semantics.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `resolveContextWindow` returns `state.modelContextLimit` when set, and
        undefined otherwise — deliberately NOT falling back to an absolute
        `compress.maxContextLimit` (soft nudge threshold, not a backend window;
        pruning to it regressed e2e-blocks-nudges by starving the nudge of its
        compressible targets).
  - [ ] `estimateWireTokens` = last-assistant reported usage + tokens of messages
        after it; falls back to full content estimate + systemPromptTokens when no
        assistant token data exists.
  - [ ] `enforceContextBudget` is a no-op when the window is unknown or the estimate
        is within budget.
  - [ ] Over budget: largest old compressible tool outputs are truncated
        (prefix+suffix, same marker as `truncateLargeToolOutputs`) until the estimate
        fits; if truncation alone cannot fit, oldest outputs are cleared to the
        standard placeholder.
  - [ ] Protections hold: first user message, last 3 messages, `protectedTools`,
        compress-tool outputs (summaries), already-cleared outputs.
  - [ ] Idempotent: a second run after pruning does not modify messages further.
  - [ ] Once-per-session WARN when the model reports no window and the catalog has no
        entry, with actionable guidance (opencode.json `limit` or absolute
        `compress.maxContextLimit`).
- **Performance / Stability**:
  - [ ] No measurable overhead on the under-budget path beyond one
        `getCurrentTokenUsage` scan (already computed elsewhere in the pipeline).
- **Regression**:
  - [ ] New test file `tests/enforce-budget.test.ts` added and passing.
  - [ ] Full suite green: `npm run build`, `npm run typecheck`, `npm test`.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/messages/enforce-budget.ts` (new) — window resolution, wire estimation,
    deterministic prune-to-fit.
  - `lib/hooks.ts` — call the guard right after `truncateLargeToolOutputs` in
    `messages.transform`; warn-once after model-limit reconciliation.
  - `lib/config.ts` — new optional `compress.completionReserveTokens` (default
    32768, covering opencode's 32,000 `max_tokens` fallback).
  - `lib/state/types.ts` + `lib/state/state.ts` — transient
    `noContextLimitWarned` flag (not persisted).
  - `dcp.schema.json`, `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` — docs.
  - `tests/enforce-budget.test.ts` (new).
- **Risks**:
  - Over-pruning if the estimate overshoots (tokenizer vs backend tokenizer drift):
    mitigated by the reserve margin (default 32768 >> drift) and by only pruning
    compressible tool outputs, never user text or summaries.
  - Estimate undercount when a backend counts `max_tokens` differently: reserve is
    configurable via `completionReserveTokens`.
- **Rollback strategy**: Revert the single commit; all changes are additive and the
  guard is a no-op without an absolute/known window.
