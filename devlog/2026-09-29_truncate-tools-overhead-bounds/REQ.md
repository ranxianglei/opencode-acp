# REQ - Bound the overheadErrorLogged Set (truncate-tools)

- Task ID: `2026-09-29_truncate-tools-overhead-bounds`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: Done
- Priority: P2 (MINOR)
- Owner: ework-daemon agent
- References: https://github.com/ranxianglei/opencode-acp/issues/461

## 1. Background & Problem Statement

- **Context**: `lib/messages/truncate-tools.ts` dedups its "model context window too
  small to fit overhead" ERROR with a module-level `Set<string>` (`overheadErrorLogged`,
  line 23), keyed by `state.sessionId`. The set is populated at lines 69–70 and never
  cleaned up — no `delete`, no LRU, no session-end hook.
- **Current behavior (symptom)**: One key accumulates per session that ever hit the
  error branch, for the whole process lifetime. On a long-lived opencode server this
  grows linearly without bound. Additionally, the comment above line 22 promises "logged
  once per session" while describing retention as if the condition were process-stable —
  misleading on read.
- **Expected behavior**: Memory for this structure is upper-bounded independently of the
  number of sessions; per-session once-only logging is preserved under normal conditions.
- **Impact**: MINOR — one short string per affected session, and only sessions whose model
  window < system prompt + output reserve (rare ERROR path) add keys. Also creates test
  coupling: `tests/truncate-tools.test.ts:318-320` documents that earlier tiny-window tests
  would mask the later "window too small" assertion because the module-level set persists
  across tests in a process.

## 2. Reproduction (if applicable)

- **Environment**: code inspection (per issue #461); no live-host repro needed.
- **Minimal reproduction steps**:
    1. Run opencode as a long-lived server with ACP.
    2. Start many sessions whose model context window is smaller than
       `systemPromptTokens + OUTPUT_RESERVE_TOKENS` (16384).
    3. Each such session adds its sessionId to `overheadErrorLogged`; keys are never removed.
- **Relevant configuration**: none (always-on code path in `truncateLargeToolOutputs`,
  called from `lib/hooks.ts:403` on every message transform).

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: log message text, log level, and once-per-session semantics
      must be unchanged for sessions that stay within the bound. No persisted-state or API
      changes.
    - Performance requirements: O(1) per call; eviction work must not run on the hot path
      when the set is below the cap.
    - Resource limits: worst-case memory for the set is fixed by the cap.
- **Non-Goals** (explicitly out of scope):
    - Session-end-event-based eviction (considered, rejected: requires cross-module wiring of
      lifecycle events and still leaks on crash/kill paths; bounding alone guarantees the
      upper bound regardless).
    - Auditing other module-level collections (grep confirmed this is the only module-level
      Set in `lib/` populated from session data).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] A session hitting the error branch logs exactly once per call sequence (dedup kept).
    - [ ] After more than `MAX_OVERHEAD_ERROR_SESSIONS` distinct sessions have been seen, the
          oldest key is evicted (FIFO by insertion order).
    - [ ] An evicted-but-still-active session logs at most one duplicate ERROR line, then
          dedup resumes (re-insertion makes the key newest again).
    - [ ] Comments above the set describe the actual bounded policy.
- **Performance / Stability**:
    - [ ] Below the cap, behavior and cost are identical to before (no eviction work).
- **Regression**:
    - [ ] New/modified test cases added to test suite and passing
          (`tests/truncate-tools.test.ts`).
    - [ ] Full suite green; new eviction test verified to FAIL against the pre-fix code.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/messages/truncate-tools.ts` — cap constant + FIFO-evicting record helper; call
      site in `truncateLargeToolOutputs`.
    - `tests/truncate-tools.test.ts` — dedup + eviction regression tests.
- **Risks**: Eviction can cause one duplicate ERROR line for a still-active broken-window
  session after >1024 other such sessions appeared — accepted tradeoff, disclosed in PR.
- **Rollback strategy**: Revert the single commit; no state format involved.
