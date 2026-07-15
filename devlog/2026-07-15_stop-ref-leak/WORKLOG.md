# WORKLOG - Stop leaking message refs in compression block metadata

- Task ID: `2026-07-15_stop-ref-leak`
- Branch: `2026-07-15_stop-ref-leak`
- Base: `github/master` @ `3fa1415`

## Root Cause

The model reads mNNNNN refs from compression block metadata (recap range field) and copies them into compress calls targeting already-compressed ranges → phantom blocks (#93).

## Fix

Replaced all model-visible block range displays with message counts. Three leak sites fixed:

### Leak #1: Automatic recap injection (`lib/messages/prune.ts`)
- `computeBlockRange(startId, endId)` → `computeBlockCoverage(effectiveMessageIds)` returns count
- `createSyntheticToolRecap` param changed: `range: string | undefined` → `messageCount: number | undefined`
- Recap tool input: `{ blockId, range: "(m01309–m02150)" }` → `{ blockId, messages: 842 }`

### Leak #2: `acp_context_recap` tool (`lib/compress/recap.ts`)
- `formatRange(startId, endId)` → `formatCoverage(block)` uses `block.effectiveMessageIds.length`
- Single block footer: `[Block b5 | m01309–m02150 | topic]` → `[Block b5 | 842 messages | topic]`
- List view: `b5 | m01309–m02150 | "topic"` → `b5 | 842 messages | "topic"`

### Leak #3: `acp_status` compressed view (`lib/compress/status.ts`)
- `formatIdRange(block)` returns `${count} msgs` instead of `${startId}–${endId}`

## Files changed
1. `lib/messages/prune.ts` — `computeBlockRange` → `computeBlockCoverage`, call site updated
2. `lib/messages/utils.ts` — `createSyntheticToolRecap` signature + input field
3. `lib/compress/recap.ts` — `formatRange` → `formatCoverage`, import CompressionBlock, 2 call sites
4. `lib/compress/status.ts` — `formatIdRange` body changed to count
5. `tests/acp-status.test.ts` — 2 tests rewritten for count format
6. `devlog/2026-07-15_stop-ref-leak/` — REQ + WORKLOG

## Verification
- TypeScript: 0 errors
- Tests: 713/713 pass
