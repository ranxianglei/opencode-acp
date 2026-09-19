# REQ - Migrate legacy 4-digit CompressionBlock boundary refs at load and fork transfer

- Task ID: `2026-09-17_legacy-block-ref-migration`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P2
- Owner: ework-agent
- References: https://github.com/ranxianglei/opencode-acp/issues/415 (item R4), https://github.com/ranxianglei/opencode-acp/pull/409

## 1. Background & Problem Statement

- **Context**: Since v1.1.0 message refs are canonical 5-digit (`m00001`). Pre-1.1.0 persisted state carries 4-digit refs (`m0001`). At session load, `lib/state/state.ts` migrates the 4→5-digit refs inside `messageIds.byRawId`/`byRef` (state.ts:429-440) and re-saves state — but `CompressionBlock.startId`/`endId` boundaries are never migrated, so a legacy session's saved file ends up with a 5-digit ref map next to 4-digit block boundaries.
- **Current behavior (symptom)**:
    1. Own-session load: `loadPruneMessagesState` (lib/state/utils.ts:238-239) passes `startId`/`endId` through verbatim → loaded blocks keep 4-digit boundaries forever (re-saved on every transform, so the mixed format is permanent until the block deactivates).
    2. Fork transfer: `restoreForkCompressionState` (lib/state/rebuild.ts:242-251) reads the parent's raw `PersistedSessionState` (via `loadSessionState`, which does not normalize blocks) and spreads `...block`, carrying 4-digit boundaries into the fork while every other ref in the fork state is 5-digit.
- **Expected behavior**: Block boundary refs are normalized to canonical 5-digit form at both ingestion points, matching the ref map migration. Non-ref values (empty strings, `bN` compressed-block refs, free text) pass through unchanged.
- **Impact**: Low severity, no functional breakage — boundary resolution never goes through `byRef` (it uses raw IDs + blockId). Concrete consumers affected:
    - `hideConsumedCompressCalls` range-key matching (lib/compress/hide-consumed.ts): pre-fix, both sides were consistently 4-digit in legacy sessions (block boundary and the immutable historical tool input), so batch filtering worked; naively migrating only the block side would REGRESS that consumer (5-digit block key vs 4-digit input entry → consumed batch-mate summaries leak back into context). The fix therefore also width-normalizes both sides of `rangeKey`, making the comparison robust to either width.
    - Export/recap display and persistence carry inconsistent ref widths (cosmetic; breaks any width-based parsing downstream).

## 2. Reproduction (if applicable)

- **Environment**: Node 22+/24, any OS (pure logic + unit tests).
- **Minimal reproduction steps** (unit level):
    1. Build a persisted prune state whose block has `startId: "m0001"`, `endId: "m0002"` (4-digit, pre-1.1.0 shape) alongside a 5-digit `messageIds.byRef`.
    2. Call `loadPruneMessagesState(...)` → block keeps `m0001`/`m0002` (bug; expected `m00001`/`m00002`).
    3. Call `restoreForkCompressionState(forkState, forkMessages, parent, parentMessages, logger)` with the same legacy parent record → fork block keeps 4-digit boundaries (bug).
- **Relevant configuration**: none (independent of config).

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: persisted-state readers must keep working; the change only rewrites ref _width_ at load time, never raw IDs or block structure. Must not touch internal `dcp-*` tags or schema.
    - Performance requirements: O(1) per block field (regex parse), no new I/O.
    - Resource limits: n/a.
- **Non-Goals** (explicitly out of scope):
    - The other nine items of issue #415 (OpenCode V2 runtime/projection/harness gaps) — verified not applicable to this V1-only repo; they belong to ranxianglei/billion-context (see issue comment).
    - Migrating 4-digit refs anywhere else (e.g., inside summary text) — out of scope by design.
    - Changes to PR #409's branch — this fix lands independently on master and covers both paths.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] `migrateMessageRef("m0001") === "m00001"`, 5-digit input byte-identical, non-refs (`""`, `"b3"`, garbage) unchanged.
    - [ ] `loadPruneMessagesState` migrates 4-digit block `startId`/`endId` to 5-digit; leaves 5-digit, `bN`, empty, and garbage values unchanged.
    - [ ] `restoreForkCompressionState` produces fork blocks with 5-digit boundaries when the parent record carries 4-digit boundaries; all other translation behavior unchanged.
    - [ ] `hideConsumedCompressCalls` batch filtering is width-independent: migrated 5-digit block keys still match legacy 4-digit tool-input entries (regression guard for the migration itself).
    - [ ] Red/green proof: new tests FAIL without the code fix, pass with it (§5.7.3 discipline).
- **Performance / Stability**:
    - [ ] Full test suite green; `npm run typecheck` and `npm run build` pass; no new dependencies.
