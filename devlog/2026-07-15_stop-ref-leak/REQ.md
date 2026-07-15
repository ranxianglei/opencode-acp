# REQ - Stop leaking message refs in compression block metadata

- Task ID: `2026-07-15_stop-ref-leak`
- Home Repo: `opencode-acp`
- Created: 2026-07-15
- Status: Done
- Priority: P0
- Owner: sisyphus
- References: GitHub #93, #135, dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: Phantom blocks (#93) occur when the model compresses an already-compressed range. The model sees message refs (`m01309–m02150`) in compression block metadata and copies them into new compress calls. All messages are already active → 0 newly compressed → phantom block with 0 tokens saved but summary overhead → model sees context didn't shrink → retries → loop.
- **Current behavior (symptom)**: Block metadata leaks mNNNNN refs in 3 model-visible surfaces:
  1. `lib/messages/prune.ts` — automatic recap injection `input.range: "(m01309–m02150)"` (every turn)
  2. `lib/compress/recap.ts` — `acp_context_recap` tool output `b5 | m01309–m02150 | "topic"`
  3. `lib/compress/status.ts` — `acp_status` compressed view `b5 ... m01309–m02150 ...`
- **Expected behavior**: Block metadata shows message COUNT, not raw refs. Model can gauge block scope without being able to copy refs into compress calls.
- **Impact**: Eliminates the primary phantom-block trigger at the source. PR #148 (`checkPhantomBlock`) remains as defense-in-depth for edge cases (e.g. #135 revert desync).

## 2. Constraints & Non-Goals

- **Constraints**:
  - `startId`/`endId` remain STORED in `CompressionBlock` for internal logic (not removed from type)
  - `blockId` remains exposed for decompress targeting (the only legitimate model use)
  - Summary text `[[REF:mNNNNN|desc]]` markers are separate (model-authored, for decompress) — NOT changed
- **Non-Goals**: Removing `startId`/`endId` from the type; changing summary content format; fixing #135 revert desync.

## 3. Acceptance Criteria

- **Correctness**:
  - [x] No mNNNNN refs in any model-visible block metadata (recap input, recap tool output, acp_status)
  - [x] Message count shown instead (`N messages` / `N msgs`)
  - [x] `blockId` still exposed for decompress
- **Regression**:
  - [x] Full test suite passing (713/713)

## 4. Proposed Approach

- **Affected modules**:
  - `lib/messages/prune.ts` — `computeBlockRange` → `computeBlockCoverage` (count)
  - `lib/messages/utils.ts` — `createSyntheticToolRecap` param: `range: string` → `messageCount: number`
  - `lib/compress/recap.ts` — `formatRange(startId, endId)` → `formatCoverage(block)` (count)
  - `lib/compress/status.ts` — `formatIdRange(block)` returns count
  - `tests/acp-status.test.ts` — 2 tests updated for count format
- **Risks**: Low. Count is informational metadata; no mechanism depends on the ref range.
