# WORKLOG: summaryBuffer over-counting fix

## Changes

### `lib/state/utils.ts`
- `getActiveSummaryTokenUsage(state, visibleMessageIds?)`: Added optional filter.
  When provided, only counts blocks whose `compressMessageId` is in the set.
  Blocks without `compressMessageId` are counted regardless (backward compat).

### `lib/messages/inject/utils.ts`
- `isContextOverLimits`: Builds `new Set(messages.map(m => m.info.id))` and passes
  to `getActiveSummaryTokenUsage`. This represents the messages opencode is about
  to send to the API (after its own compaction).

### `lib/commands/stats.ts`
- `handleStatsCommand`: Builds visibleMessageIds from ctx.messages. Filters
  `sessionSummaryTokens` to only count visible summaries.

### `tests/summary-buffer-visibility.test.ts` (NEW)
7 tests covering: no filter (backward compat), inactive skip, filter, empty set,
all visible, missing compressMessageId, 448-block simulation.

### `tests/token-usage.test.ts`
Fixed 2 tests: block 7 `compressMessageId` set to `"msg-assistant-post-compaction"`
(must be in visible messages for summaryBuffer to count after the fix).

## Verification
- typecheck: PASS
- tests: 880 pass (873 original + 7 new)
- build: PASS
