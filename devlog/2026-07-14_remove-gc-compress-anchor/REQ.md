# REQ: Remove GC + Compress-as-Anchor + Emergency Strategy (v1.13.0)

## Problem

Three interconnected issues in ACP's context management:

1. **GC mechanism causes problems**: Age-based block deactivation, summary truncation, and batch merge add complexity and can silently destroy information. Truncation targets compression summaries (wrong priority — should target tool outputs first).

2. **Synthetic recap messages are fragile**: `createSyntheticToolRecap` injects fake assistant+tool message pairs that can confuse the model (empty tool call structure, synthetic tool name). `stripStaleCompressCalls` adds complexity by removing real compress tool calls from old turns.

3. **No emergency fallback**: When context hits 100%, the only mechanism is GC truncation of summaries. There's no priority-based pruning (tool outputs first, summaries last).

## Solution

### Phase 1: Complete GC Removal
- Delete `lib/gc/truncate.ts` and `lib/gc/merge.ts`
- Remove `runMajorGC` + `runBatchCleanup` from hooks.ts pipeline
- Remove `gc` config section entirely (with deprecation warning for old configs)
- Stop survivedCount/generation logic in compress/state.ts (keep fields on type for persisted state compat)
- Remove aging guidance from nudge.ts extension
- Blocks live forever until consumed (nested compression) or decompressed

### Phase 2: Compress Tool Call as Block Anchor
- `filterCompressedRanges`: remove synthetic recap injection, keep message hiding via byMessageId
- Remove `stripStaleCompressCalls` — compress tool calls stay visible (carry summary in input)
- `syncCompressionBlocks`: deactivate blocks when `compressMessageId` is missing (not `anchorMessageId`)
- Decompress = deactivate block → originals reappear + compress call stays visible ("two copies" acceptable)
- No summary sync needed for normal compress (summary already in tool call input). Recompress edge case deferred.

### Phase 3: Emergency Pruning Strategy
- New ephemeral module for transform-time pruning (no state mutation)
- Trigger: context >= `emergencyPruneThreshold` (default 95%)
- Priority: tool call outputs first (oldest non-protected), compression summaries last resort
- Target: reduce to `emergencyPruneTarget` (default 85%)
- Tool output stubbing: replace `state.output` with stub string during transform only

## Config Changes

New fields in `compress`:
- `emergencyPruneThreshold: number | \`${number}%\`` (default "95%")
- `emergencyPruneTarget: number | \`${number}%\`` (default "85%")

Removed:
- Entire `gc` section (`gc.algorithm`, `gc.promotionThreshold`, `gc.maxBlockAge`, `gc.maxOldGenSummaryLength`, `gc.majorGcThresholdPercent`, `gc.batchCleanup.*`)

## Behavior Changes

- Blocks no longer auto-deactivate by age (no maxBlockAge)
- Summaries never auto-truncated (no maxOldGenSummaryLength)
- No batch merge of old blocks
- Compress tool calls visible in context (not stripped)
- No synthetic recap messages
- At 95% context: automatic ephemeral tool output pruning
