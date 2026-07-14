# REQ - Message Ref Format Expansion

- Task ID: `2026-05-18_msgid-expansion`
- Home Repo: `opencode-acp`
- Created: 2026-05-18
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: PR #1 (branch `feat/msgid-expansion`)

## 1. Background & Problem Statement

- **Context**: ACP uses short message refs (`m0`, `m1`, ..., `m9999`) for model-facing IDs. The format `mNNNN` (4-digit padded) limits the system to 10,000 messages per session.
- **Current behavior (symptom)**: Sessions exceeding 10,000 messages will produce duplicate refs (`m0000` wraps around), causing compress tool failures (ambiguous boundary resolution).
- **Expected behavior**: Ref format expanded to `mNNNNN` (5-digit padded, supporting up to 99,999 messages). Old 4-digit refs in persisted state must be migrated automatically.
- **Impact**: Without this fix, long-running sessions (10,000+ messages — ACP's target use case) will break silently.

## 2. Reproduction (if applicable)

- **Environment**: Node 22+
- **Minimal reproduction steps**:
    1. Create a session with >10,000 messages
    2. Observe message refs wrap around to `m0000`
    3. Call compress — boundary resolution fails with ambiguous refs
- **Relevant configuration**: Default config, range mode

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: Old persisted state with 4-digit refs must be auto-migrated on load
    - No data loss: `byRef` map keys must be normalized to 5-digit format
    - PR must pass CI (typecheck + test + build on Node 22/24)
- **Non-Goals**:
    - Configurable ref format (overkill for now)
    - Changing block ID format (`b0`, `b1`, ...) — no known limit issue there

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] Message refs use 5-digit format (`m00000` through `m99999`)
    - [x] Old 4-digit refs in persisted state are auto-migrated to 5-digit
    - [x] `byRef` map keys are normalized (no mixed 4/5 digit keys)
    - [x] All 350 tests pass
- **Performance / Stability**:
    - [x] No performance regression
- **Regression**:
    - [x] Backward compat: old state files load correctly
    - [x] CI passes (Node 22/24 matrix)

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/message-ids.ts` — Core ref format change
    - `lib/compress/state.ts` — Migration in `ensureSessionInitialized`
    - `lib/compress/message-utils.ts` — ISSUE_TEMPLATES dedup
    - `lib/state/state.ts` — State loading migration
- **Risks**: Mixed 4/5 digit keys in `byRef` map causing lookup failures
- **Rollback strategy**: Revert commits; 4-digit format still works for <10k messages
