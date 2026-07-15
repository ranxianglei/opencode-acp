# REQ: Smart Nudge Gating

## Problem

Three issues with compression recommendation behavior:

1. **Last segment compressed by model** — The breakdown marks the last (most recent) segment as "may still be in active use", but the model compresses it anyway, losing track of what it was doing. The model should be warned on first attempt but allowed on retry.

2. **Single-message ranges over-recommended** — The breakdown recommends single-message ranges (usually the latest message) even though they shouldn't be compressed. Should only recommend if the range exceeds 5× the growth percentage (25% of context at 5% config).

3. **Protected-dominated recommendations** — The breakdown recommends compression even when most content is protected (skill/task/todowrite tools), offering little benefit. Should suppress when: besides the last range all others are protected, 70%+ is protected, or remaining compressible < 5% of context.

## Requirements

### Req 1: Soft-block on last segment
- First compress attempt covering the most recent message → FAIL with confirmation prompt
- Record the lastMessageId in state; second attempt (same lastMessageId) → succeed
- Configurable via `compress.lastSegmentSoftBlock` (default: true)
- Applies to both range-mode and message-mode compress tools

### Req 2: Single-message range filtering
- Exclude single-message ranges from recommendation unless tokens > 5× growth threshold
- Growth threshold = modelContextLimit × 0.05 (e.g., 50K for 1M context)
- Huge threshold = 5 × growth threshold (e.g., 250K for 1M context)

### Req 3: Protected dominance filtering
- Suppress all recommendations when:
  - Besides the last compressible range, all others are protected
  - 70%+ of total (compressible + protected) tokens are protected
  - Remaining compressible tokens < growth% of model context
- Unless a huge single segment (> 5× growth) overrides

## Files Changed

- `lib/state/types.ts` — `Nudges.lastSegmentConfirmAttempts: Set<string>`
- `lib/state/state.ts` — Initialize + load `lastSegmentConfirmAttempts`
- `lib/state/persistence.ts` — Serialize/deserialize `lastSegmentConfirmAttempts`
- `lib/state/utils.ts` — Reset on compaction
- `lib/config.ts` — `CompressConfig.lastSegmentSoftBlock?: boolean` (default true)
- `lib/compress/pipeline.ts` — `getLastVisibleMessageId()` + `checkLastSegmentSoftBlock()`
- `lib/compress/range.ts` — Integrate soft-block check
- `lib/compress/message.ts` — Integrate soft-block check
- `lib/messages/inject/utils.ts` — `filterRecommendedRanges()` + `RangeFilterOptions`
- `lib/messages/inject/inject.ts` — Apply filter before showing recommendation
- `tests/smart-nudge-gating.test.ts` — 15 tests for filterRecommendedRanges
- `tests/soft-block.test.ts` — 5 tests for soft-block behavior
- 6 existing test files updated for compatibility
