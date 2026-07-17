# WORKLOG - Reject phantom compression blocks

## Commits

1. `feat: reject phantom compression blocks (0 new direct messages)` — `checkPhantomBlock` in pipeline.ts + call sites in range.ts/message.ts
2. `test: 12 tests for checkPhantomBlock phantom block detection` — `tests/phantom-block.test.ts`
3. `docs: devlog for reject-empty-blocks`

## Key Files

| File | Change |
|------|--------|
| `lib/compress/pipeline.ts` | New `checkPhantomBlock(state, plans)` — stateless pre-check, returns Error if any plan would produce 0 newly-compressed messages |
| `lib/compress/range.ts` | Call `checkPhantomBlock` before snapshot/compression loop (after `checkLastSegmentDangerous`) |
| `lib/compress/message.ts` | Same call site (consumedBlockIds always `[]` in message mode) |
| `tests/phantom-block.test.ts` | 12 tests: new messages, all-active, consumed-block, multi-plan, edge cases |

## Algorithm

`checkPhantomBlock` mirrors `applyCompressionState`'s `newlyCompressedMessageIds` computation:

1. Build `effective` message set = `plan.messageIds` + consumed blocks' `effectiveMessageIds`
2. A message is "new" if `!entry || entry.activeBlockIds.length === 0` (not currently active under any block)
3. If NO message is new → phantom → return Error

Key insight: messages active under consumed blocks are NOT "new" — re-labeling them under a new block doesn't newly hide them (they were already hidden by the consumed block). This matches `applyCompressionState`'s `wasActive` check.

## Test Results

- typecheck: 0 errors
- phantom-block tests: 12/12 pass
- Full suite: 725/725 pass (713 existing + 12 new)

## Lesson

The phantom block bug (#93) is the root cause of the "compresses zero, creates summary" loop reported in #135. It's a compress-tool validation gap, not a nudge-frequency issue. Our recent smart-nudge-gating work (filter, dangerous param, growth-floor) all REDUCE compression frequency and did NOT introduce this bug.
