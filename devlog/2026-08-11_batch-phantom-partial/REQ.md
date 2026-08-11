# REQ: partial-failure batch compress + phantom diagnostics (issue #290)

- Task ID: `2026-08-11_batch-phantom-partial`
- Home Repo: `opencode-acp`
- Created: 2026-08-11
- Status: InProgress
- Priority: P1
- Owner: awork
- References: upstream issue https://github.com/ranxianglei/opencode-acp/issues/290 ; local dog/opencode-acp#47 ; builds on #288/#289

## 1. Background & Problem Statement

- **Context**: Batch `compress` calls (5–6 entries in `content[]`) are the
  recommended way to compress unrelated ranges in one turn. They share one
  tool invocation and produce multiple `CompressionBlock`s.
- **Current behavior (symptom)**: When ANY single entry in a batch contains
  only already-compressed messages, `checkPhantomBlock` throws on the first
  phantom plan and the ENTIRE batch is aborted — the remaining valid entries
  are never executed. The error message is also generic: it names the entry
  index ("range N") but not the conflicting message IDs or the owning block
  IDs, forcing trial-and-error retry loops.
- **Expected behavior**:
  - A. Partial-failure batches: skip the phantom entries, compress the valid
       ones, and surface which entries were skipped + why.
  - C. Diagnostics: the error / skip notice includes the conflicting entry
       index, a sample of the consumed message IDs, and the owning block IDs.
  - B. Clamp warning: when `clampMessageRef` silently clamps a beyond-last-
       visible ref, log a warning (defense-in-depth; the partial-failure path
       already handles the downstream phantom case).
- **Impact**: Models abandon batch compression entirely on the first stale-ref
  hit, leaving large uncompressed ranges in context. Real-session report:
  35 blocks / 3190 indexed messages, batches of 5–6 entries failing wholesale.

## 2. Reproduction

- **Environment**: opencode-acp 1.14.13 (stable), Windows desktop, OpenCode 1.18.15.
- **Minimal reproduction**:
  1. Session with one active compression block covering messages X..Y.
  2. Model issues `compress({ content: [ {valid range}, {range entirely inside X..Y}, {valid range} ] })`.
  3. Entire call throws "Compression range 2 contains only already-compressed
     messages ...". Entries 1 and 3 are not executed.
- **Relevant configuration**: default range mode; no special config required.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `checkPhantomBlock`'s existing public contract
    (returns `Error | null`, error message matches `/already-compressed/`,
    `/0 new direct messages/`, `/range N/i`) MUST be preserved — existing
    tests in `tests/phantom-block.test.ts` must pass unchanged.
  - No persisted-state schema changes.
  - No new dependencies.
  - State integrity: phantom entries must be dropped BEFORE any state
    mutation (snapshot/apply), so a partial batch never leaves ghost blocks.
- **Non-Goals**:
  - D (unify nudge judging): the reporter confirmed the nudge list is already
    correct; ghost IDs that appear there are genuinely compressible
    individually. The defect is purely batch atomicity + missing diagnostics.
    D is out of scope for this iteration.
  - Message-mode (removed from this codebase; range-mode only).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] Batch with 1 phantom + N valid entries: valid entries compress
        normally; phantom entry skipped; result message lists the skipped entry.
  - [ ] Batch where ALL entries are phantom: throws a detailed error (entry
        index + consumed IDs + owning blocks) and no state is mutated.
  - [ ] Single-entry phantom batch: throws (same as pre-fix, plus richer msg).
  - [ ] `checkPhantomBlock` existing behavior/tests unchanged.
- **Performance / Stability**:
  - [ ] No new O(n²); phantom identification is O(plans × effective-set).
- **Regression**:
  - [ ] New tests added covering partial-failure + diagnostics.
  - [ ] `npm run typecheck`, `npm test`, `npm run build` all green.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/compress/pipeline.ts` — add `identifyPhantomPlans` (returns
    per-plan diagnostics) + `buildPhantomErrorMessage`. Keep
    `checkPhantomBlock` as a legacy single-error wrapper (unchanged contract).
  - `lib/compress/range.ts` — switch the pre-mutation check from
    `checkPhantomBlock` to `identifyPhantomPlans`; drop phantom entries,
    compress the rest; hard-fail only when ALL entries are phantom; surface
    skip notice in the result string.
  - `lib/compress/search.ts` — thread optional `logger` through
    `resolveBoundaryIds`/`resolveRanges`; warn when `clampMessageRef` clamps.
- **Risks**:
  - Dropping entries changes batch semantics. Mitigation: the model sees a
    clear skip notice naming the dropped entries + owning blocks, so it can
    correct boundaries without guessing.
- **Rollback strategy**: revert the three file changes; no state migration
  needed (no schema change).
