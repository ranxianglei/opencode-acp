# REQ - Reject phantom compression blocks (0 direct messages)

- Task ID: `2026-07-15_reject-empty-blocks`
- Home Repo: `opencode-acp`
- Created: 2026-07-15
- Status: Done
- Priority: P1
- Owner: awork
- References: GitHub #93, #135; Gitea dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: When the model calls `compress` on a range that contains only already-compressed messages, `applyCompressionState` creates a block with `directMessageIds: []` and `compressedTokens: 0` — a "phantom block."
- **Current behavior (symptom)**: The compress tool succeeds, reports `+summary` but `-0 removed`. The model sees context didn't shrink, retries the same range, creates another phantom → compression loop (GitHub #135).
- **Expected behavior**: The compress tool should REJECT ranges that would produce 0 new direct messages, with a clear error telling the model to pick visible, uncompressed content.
- **Impact**: Wasted context (summary overhead with no savings), model confusion, compression loops. Reported by external user (GitHub #135, ChatGPT-5.6 Terra) and internally (GitHub #93).

## 2. Reproduction

- **Environment**: Any model, any version with compression enabled.
- **Minimal reproduction steps**:
  1. Compress range m1–m10 → block A created
  2. Call compress again with range m1–m10 (or a range containing only already-compressed messages)
  3. Block B created with `directMessageIds: []`, `compressedTokens: 0`, `effectiveMessageIds` inherited from A
- **Relevant configuration**: Default config.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no persisted state format changes
  - The check must be stateless (no mutation before rejection) — matches `checkLastSegmentDangerous` pattern
  - Must handle consumed-block scenarios correctly (consuming + re-compressing is NOT new)
- **Non-Goals**: Fixing the `prune` tool dead code (#116) — separate issue.

## 4. Acceptance Criteria

- **Correctness**:
  - [x] `checkPhantomBlock` returns Error when ALL effective messages are already active
  - [x] Returns null when ANY message is new (not active under any block)
  - [x] Consuming a block + adding a new message → valid (not phantom)
  - [x] Multi-plan batch: rejects if ANY plan is phantom
- **Performance / Stability**:
  - [x] O(n) where n = effective message count per plan
- **Regression**:
  - [x] 12 new tests in `tests/phantom-block.test.ts`, all passing
  - [x] Full suite: 725/725 pass

## 5. Proposed Approach

- **Affected modules**: `lib/compress/pipeline.ts` (new function), `lib/compress/range.ts` + `lib/compress/message.ts` (call sites)
- **Risks**: A legitimate re-compression that consumes an old block + adds ≥1 new message still works (not phantom). Only ALL-already-active ranges are rejected.
- **Rollback strategy**: Remove `checkPhantomBlock` calls — no persisted state changes.
