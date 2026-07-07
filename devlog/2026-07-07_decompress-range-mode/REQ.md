# REQ - Decompress Tool Range Mode (startId/endId)

- Task ID: `2026-07-07_decompress-range-mode`
- Home Repo: `opencode-acp`
- Created: 2026-07-07
- Status: Done
- Priority: P1
- Owner: awork
- References: issue #14, issue #13 (original discussion), PR #72 (prompt rewrite, separate concern)

## 1. Background & Problem Statement

- **Context**: ACP's `decompress` tool currently accepts only a single `blockId` (e.g. `b0`). To restore content across a range of messages the model must call `acp_status` to discover blocks, then call `decompress` individually for each block — multiple round-trips, error-prone.
- **Current behavior (symptom)**: Single-block decompress only. Restoring N blocks across a range requires N tool calls.
- **Expected behavior**: An optional `startId`/`endId` pair on the decompress schema that batch-restores every active block overlapping the range in one call.
- **Impact**: Fewer round-trips, simpler model workflow, reduced chance of picking the wrong block.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22+
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1. Compress a wide range of messages (e.g. m00150..m00200) producing several blocks
  2. Attempt to restore via decompress — only single `blockId` accepted
- **Relevant configuration**: N/A (schema-level change)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: existing `blockId` arg MUST keep working unchanged
  - `blockId` and `startId`/`endId` are mutually exclusive
  - `toFile` MUST work with both modes
  - Range mode MUST respect nested-block relationships (deactivate whole chain)
  - No new persisted state shape — reuse existing `CompressionBlock.effectiveMessageIds`
- **Non-Goals** (explicitly out of scope):
  - Partial block restore (a block is restored wholesale or not at all)
  - Changing the compress tool's schema
  - Prompt rewrite for issue #13 (stays in PR #72)

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `decompress({ blockId: "b0" })` still works exactly as before
  - [x] `decompress({ startId: "m00150", endId: "m00200" })` restores every active block whose `effectiveMessageIds` overlaps the range
  - [x] Mixing `blockId` with `startId`/`endId` returns a clear error
  - [x] Specifying only one of `startId`/`endId` returns a clear error
  - [x] Range with no overlapping active blocks returns a clear error pointing to `acp_status`
  - [x] Reversed boundaries (endId < startId) are auto-swapped (reuses search.ts Bug 34 fix)
  - [x] `toFile` works with range mode (writes effective messages across all matched blocks)
- **Performance / Stability**:
  - [x] No new persisted state, no new I/O beyond existing single-block path
- **Regression**:
  - [x] New test cases added to `tests/decompress-logic.test.ts` and passing
  - [x] Full test suite green (586 pass; 1 pre-existing unrelated Bun limitation in prompts.test.ts)

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/compress/decompress.ts` — schema + handler restructure
  - `lib/compress/decompress-logic.ts` — new `findActiveBlocksOverlappingMessages`
  - `tests/decompress-logic.test.ts` — 11 new tests
- **Risks**:
  - Low. Schema addition is backward compatible (new optional fields only). Reuses hardened boundary resolution from `compress/search.ts` (Bug 34, clamping).
- **Rollback strategy**:
  - Revert the single commit on branch `2026-07-07_decompress-range-mode`.
