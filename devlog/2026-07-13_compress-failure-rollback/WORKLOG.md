# WORKLOG: Compress Failure Rollback & Sync Carve-out Fix

## Iteration 1 — Investigation & Implementation

### Investigation

Read all relevant source files:
- `lib/messages/sync.ts` — syncCompressionBlocks with L60 carve-out
- `lib/messages/prune.ts` — filterCompressedRanges (actual filtering logic)
- `lib/compress/range.ts` — range-mode compress tool (no try/catch)
- `lib/compress/message.ts` — message-mode compress tool (no try/catch)
- `lib/compress/state.ts` — applyCompressionState (heavy state mutation)
- `lib/compress/pipeline.ts` — prepareSession/finalizeSession
- `lib/state/types.ts` — PruneMessagesState, CompressionBlock types
- `lib/state/utils.ts` — resetOnCompaction, serialize/deserialize helpers
- `lib/state/persistence.ts` — saveSessionState/loadSessionState
- `lib/strategies/deduplication.ts`, `lib/strategies/purge-errors.ts`

### Key Finding

Issue #125's described mechanism (`effectiveMessageIds - directMessageIds` filter)
does NOT exist in the source code. The actual filtering uses `byMessageId` with
`activeBlockIds`. However, the symptom (empty LLM request) is real, caused by
the sync.ts L60 carve-out keeping blocks active when their anchors are externally
deleted.

### Implementation

**Bug 2 fix** (`lib/messages/sync.ts`):
- Removed the nested `if (!messagesState.byMessageId.has(block.anchorMessageId))`
  check at L59-65
- Replaced with unconditional deactivation when anchor is missing
- Added detailed comment explaining why the carve-out was wrong

**Bug 1 fix** (`lib/compress/pipeline.ts`, `range.ts`, `message.ts`):
- Added `CompressionSnapshot` interface, `snapshotCompressionState()`, and
  `restoreCompressionState()` to pipeline.ts
- Snapshot uses `structuredClone` for `prune.messages` (deep clone, independent
  Maps/Sets), shallow copy for `stats`
- Restore also uses `structuredClone` to ensure snapshot stays pristine
- Wrapped mutation phase in try/catch in both range.ts and message.ts
- On catch: restore state, re-throw error

### Test Changes

- Updated `tests/sync.test.ts`:
  - Changed "keeps block active when anchor is in byMessageId" → "deactivates
    block when anchor is gone even if tracked in byMessageId"
  - Added "issue #125: external anchor deletion deactivates block and clears
    byMessageId activeBlockIds"

- Created `tests/compress-rollback.test.ts`:
  - snapshotCompressionState captures prune.messages and stats
  - restoreCompressionState fully restores state after mutations
  - snapshot is independent from state mutations
  - restore creates independent Maps/Sets (no shared references)

### Verification

- TypeScript: pass
- Tests: 643 pass, 0 fail
- Build: success
- Format: changed files formatted
