# REQ - Request-side overflow guard + uncalibrated-window WARN

- Task ID: `2026-08-28_overflow-guard`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/347

## 1. Background & Problem Statement

- **Context**: ACP's percentage thresholds (`minContextLimit`, `maxContextLimit`,
  `emergencyThresholdPercent`) are only as good as `state.modelContextLimit`. For a
  custom OpenAI-compatible provider that reports `limit.context = 0`, the model-limit
  catalog never records a window (`record()` drops `limit <= 0`) and the system hook
  never sets `modelContextLimit` (it guards on `limit.context`). Every percentage
  threshold then resolves to `undefined` and silently no-ops.
- **Current behavior (symptom)**: A long headless session grows past the backend's
  real window (262,144 for the reporter's sglang qwen3.8-27b) and dies on every
  resume with a `400 Bad Request` ("Requested token count exceeds the model's maximum
  context length of 262144 tokens") that opencode swallows — exit 0, no output.
  Deterministic and unrecoverable for that session id. No error is ever surfaced.
- **Expected behavior**: (a) The blindness is *visible* — a prominent one-time WARN
  tells the user their model reports no window and what to configure. (b) The request
  is *protected* — even without model cooperation, ACP deterministically keeps the
  outgoing request within the known window so a 400 becomes a degraded-but-working
  turn instead of a silent death loop.
- **Impact**: Any custom provider without a catalog entry has all percentage
  protection silently disabled. The failure mode is the worst kind: silent (exit 0),
  deterministic, and unrecoverable for the affected session.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22
  - OS/Arch: linux
  - opencode 1.14.46, plugin opencode-acp@latest, model `vllm-qwen/qwen3.8-27b`
    declared in opencode.json **without** a `limit` (so `limit.context = 0`), backend
    sglang real window 262,144, `compaction.auto: false`, per-message resume.
- **Minimal reproduction steps**:
  1) Run a long headless session against a provider that reports `limit.context = 0`.
  2) Let the context exceed the backend's real window.
  3) Resume the session → 400 → opencode exits 0 with no output, every time.
- **Relevant configuration**: no `limit` in opencode.json; default percentage
  thresholds in acp.jsonc (or none).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no change to persisted state format beyond two new
    *transient* (non-persisted) fields; no change to internal `dcp` tags.
  - Performance: the guard's precise token count must not run on every well-under
    budget turn (use the O(1) provider-reported usage as the primary estimate).
  - The guard must never clear protected tools / protected file paths (Bug 39 parity).
- **Non-Goals** (explicitly out of scope):
  - Fixing opencode's `exit 0 on 400` and `options.maxTokens not honored` bugs
    (upstream opencode issues, filed separately).
  - "Learn the window from 400s" (issue Fix 3) — **blocked**: opencode exposes no
    response-error hook to plugins, so a plugin cannot observe the 400.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] When `modelContextLimit` stays undefined across ≥ 3 transforms, a one-time
        WARN is logged per session (deduped), and the counter resets once a window
        resolves.
  - [x] When the estimated wire size exceeds `knownWindow - overflowGuardReserve`,
        the oldest compressible (non-protected) tool outputs are cleared until the
        estimate fits; the guard stops as soon as it fits and never touches the
        current turn, user messages, or the recent-message protection zone.
  - [x] `knownWindow` = `modelContextLimit` when set, else absolute
        `compress.modelMaxLimits[provider/model]`, else absolute
        `compress.maxContextLimit`; `undefined` (guard off) when only a percent is
        configured and no window is known.
- **Performance / Stability**:
  - [x] The guard is a no-op (no precise tokenization) when the O(1) estimate is
        under budget.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing
        (`tests/prune-to-fit.test.ts`, 25 tests).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/messages/prune-to-fit.ts` (new) — `pruneToFit` + `resolveKnownWindow`.
  - `lib/messages/uncalibrated-window.ts` (new) — `trackUncalibratedWindow`.
  - `lib/hooks.ts` — call both in the message-transform pipeline.
  - `lib/config.ts`, `lib/config-validation.ts`, `dcp.schema.json` — new knobs
    `compress.overflowGuard` (bool, default true) + `compress.overflowGuardReserve`
    (number, default 32768).
  - `lib/state/types.ts`, `lib/state/state.ts` — two transient fields.
  - `lib/messages/index.ts` — barrel exports.
- **Risks**: Over-pruning when the user sets `maxContextLimit` well below the real
  window (documented; the user controls the declared budget). Clearing tool outputs
  loses that output until the tool is re-run (intentional, last-resort).
- **Rollback strategy**: Set `compress.overflowGuard: false` to disable the guard;
  the WARN is harmless. Full rollback = revert the branch.
