# REQ - Invalidate stale modelContextLimit after a model switch

- Task ID: `2026-08-16_model-switch-stale-limit`
- Home Repo: `opencode-acp`
- Created: 2026-08-16
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: issue #312

## 1. Background & Problem Statement

- **Context**: `state.modelContextLimit` drives every percentage-based threshold — `emergencyThresholdPercent`, `min/maxContextLimit`, adaptive `nudgeGrowthTokens`, GC/batch-cleanup gates. It is written only by the `experimental.chat.system.transform` handler.
- **Current behavior (symptom)**: After switching models mid-session (issue #312: 200K → 1M), the emergency compression configured at 50% fires when the host TUI shows only 26% of the new window. The cached limit still describes the PREVIOUS model's window, so `50% × 200K = 100K` is compared against 260K real tokens.
- **Expected behavior**: Thresholds are never computed against a window that does not belong to the current model. On the first turn after a switch, the limit is treated as unknown (the same semantics already used for providers that omit `model.limit.context`) until the system-prompt hook refreshes it within the same turn.
- **Impact**: False "Context limit reached" emergency nudges, false min/max-limit nudges, and a mis-scaled adaptive nudge growth floor (10K instead of 50K) on the first turn after any model switch. The false emergency anchor/baseline side effects persist into later turns.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22+
  - OS/Arch: linux-x64
  - OpenCode: stable v1.14.45 (hook ordering confirmed in `packages/opencode/src/session/prompt.ts:1583` → `session/llm.ts:118`)
- **Minimal reproduction steps**:
  1) Run a session on a model whose `limit.context` is 200K until the conversation exceeds 100K tokens (e.g. 260K on a model whose effective window exceeds its reported 200K limit).
  2) Switch the session to a model with a 1M context window.
  3) Send the next message. The first `messages.transform` of the new turn evaluates thresholds against the stale 200K limit → 50% emergency threshold = 100K ≤ 260K → emergency nudge injected although the TUI shows 26% of 1M.
- **Relevant configuration**: `compress.emergencyThresholdPercent: "50%"` (any percentage threshold exhibits the bug; absolute-number thresholds are unaffected).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: existing persisted state JSON files (without the new fields) must load without changes to on-disk format.
  - Performance requirements: no new API calls per turn (explicitly NOT fetching model limits via `client.app.providers()` — see DESIGN §5).
  - Resource limits: no new state beyond two optional string fields.
- **Non-Goals** (explicitly out of scope):
  - Making the first turn after a switch fully correct (1-turn "limit unknown" window is accepted — same semantics as a fresh session's first turn).
  - Changing OpenCode's hook ordering (upstream change, out of scope).
  - Fixing host-TUI percentage display (host-side, not ACP).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] After a model switch, the first `messages.transform` never uses the previous model's `modelContextLimit` for any threshold (emergency, min/max, adaptive growth, GC, filters).
  - [x] The system-prompt handler records the model identity together with the limit, so subsequent transforms use the correct window.
  - [x] Same-model transforms never invalidate the limit (no steady-state flicker).
  - [x] Emergency threshold math is unchanged when the limit and model agree (control test: 800K/1M at 50% still fires).
- **Performance / Stability**:
  - [x] No new per-transform scans beyond one `findLast` (model info) — comparable to existing `getLastUserMessage` scans already in the transform.
  - [x] Legacy state files (no identity fields) load fine; the unverifiable limit is invalidated on the first transform, then repopulated by system.transform the same turn.
- **Regression**:
  - [x] New test cases added to test suite and passing: `tests/model-switch-limit.test.ts` (9 tests; the e2e #312 regression was verified to FAIL when the fix is disabled).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/state/types.ts` — `SessionState.modelProviderID?` / `modelID?`
  - `lib/state/utils.ts` — `syncModelIdentity()`
  - `lib/state/state.ts` — init/reset/restore
  - `lib/state/persistence.ts` — additive persisted fields
  - `lib/hooks.ts` — identity store (system handler) + invalidation (message transform)
- **Risks**: One turn of degraded (unknown-limit) behavior after a switch — the documented, safe path.
- **Rollback strategy**: Revert the branch; persisted new fields are ignored by older code (additive).
