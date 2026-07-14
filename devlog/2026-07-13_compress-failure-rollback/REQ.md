# REQ: Compress Failure Rollback & Sync Carve-out Fix

## Problem

Two bugs in ACP's post-compression-failure handling (upstream issue #125):

### Bug 1: No state rollback on compress tool failure

`lib/compress/range.ts` and `lib/compress/message.ts` mutate in-memory state
incrementally via `applyCompressionState()` in a loop. There is no try/catch,
no snapshot/rollback. If anything throws between the first `applyCompressionState`
and `finalizeSession()` (which persists state), the in-memory state is left with
"ghost blocks" — active blocks that were never persisted.

Ghost blocks affect subsequent message-transform runs: they hide messages and
inject recaps despite the failure. On session restart, ghost blocks disappear
(persisted state doesn't have them), creating memory/disk inconsistency.

### Bug 2: sync.ts L60 carve-out causes message loss (issue #125 root cause)

`lib/messages/sync.ts:54-66` had a carve-out: when a block's anchor message is
missing from the current message list, the block is kept active if the anchor
is tracked in `byMessageId`. The intent was to handle anchors hidden by ACP
compression.

However, `syncCompressionBlocks` runs on the **RAW message list** (before
`filterCompressedRanges`), so ACP-hidden anchors are still present in the list.
The carve-out only triggered for **externally-deleted** anchors (OpenCode
compaction or manual message deletion).

When the carve-out keeps a block active but the anchor is gone,
`filterCompressedRanges` hides the block's messages (via `byMessageId`
`activeBlockIds`) but cannot inject the recap (no anchor in message list) →
**empty LLM request**. This is the exact symptom from issue #125.

## Solution

### Fix 1: State snapshot/rollback

Add `snapshotCompressionState()` and `restoreCompressionState()` to
`lib/compress/pipeline.ts`. Wrap the mutation phase (from `allocateRunId` to
`finalizeSession`) in both `range.ts` and `message.ts` with try/catch. On
failure, restore the snapshot and re-throw.

Snapshot covers `state.prune.messages` (deep clone via `structuredClone`) and
`state.stats` (shallow copy — only two number fields).

### Fix 2: Remove sync.ts carve-out

Replace the nested if/continue at sync.ts:54-66 with a simple deactivation
when the anchor is missing. This is correct because:

1. `syncCompressionBlocks` runs on the raw message list → ACP-hidden anchors
   are still present → carve-out never triggers for them
2. After OpenCode compaction, anchors are gone → blocks deactivated →
   `byMessageId` `activeBlockIds` cleared → surviving messages unhidden →
   clean state
3. Without the anchor, `filterCompressedRanges` cannot inject recaps anyway

## Files Changed

- `lib/messages/sync.ts` — removed carve-out (Bug 2)
- `lib/compress/pipeline.ts` — added snapshot/restore helpers (Bug 1)
- `lib/compress/range.ts` — try/catch with rollback (Bug 1)
- `lib/compress/message.ts` — try/catch with rollback (Bug 1)
- `tests/sync.test.ts` — updated carve-out test, added issue #125 test
- `tests/compress-rollback.test.ts` — new: snapshot/restore tests

## Acceptance Criteria

- [x] All 643 tests pass
- [x] TypeScript type check passes
- [x] Build succeeds
- [x] sync.ts deactivates blocks when anchor is externally deleted (even if in byMessageId)
- [x] compress tool restores state on failure (no ghost blocks)
- [x] No backward compatibility issues (persisted state format unchanged)
