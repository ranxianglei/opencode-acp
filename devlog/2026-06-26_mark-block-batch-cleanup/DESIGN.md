# DESIGN: mark_block + Batch Cleanup

## Architecture

### New state field

`PruneMessagesState` in `lib/state/types.ts`:

```ts
markedForCleanup: Set<number> // blockIds marked by model for batch cleanup
```

Persisted in session state JSON. Loaded/saved via existing persistence mechanism.

### New tool: mark_block

Registered in `index.ts` alongside compress/decompress.

**Input**: `blockId: string` (e.g., "b0", "b3")
**Behavior**:

1. Resolve blockId → numeric ID
2. Validate block exists and is active
3. Add to `state.prune.messages.markedForCleanup`
4. Return confirmation: "Block bN marked for cleanup. It will be merge-compressed when context pressure rises. No immediate effect on context or cache."
   **Zero cache impact**: doesn't modify any messages or block summaries.

### New tool: unmark_block (optional)

Allow model to unmark if it changes its mind. Same input, removes from set.

### Batch cleanup triggers in hooks.ts

Added to the message transform pipeline, after `runMajorGC()` and before `prune()`:

```ts
// Three-tier batch cleanup for marked blocks
runBatchCleanup(state, config, logger, messages, currentUsagePercent)
```

**Tier 1 — Low threshold (configurable, default 60%)**:

- Action: inject nudge text into the last user message
- Nudge: "⚠️ N blocks marked for cleanup (b0, b1, ...). Consider merge-compressing them to free ~M tokens. Use compress with a range covering these blocks."
- No automatic action — just reminds the model

**Tier 2 — High threshold (configurable, default 75%)**:

- Action: automatic merge-compress of all marked blocks
- Concatenate marked block summaries → create one new block with merged summary
- Deactivate old marked blocks
- One cache break, maximum cleanup

**Tier 3 — Near-100 (configurable, default 90%)**:

- Action: force merge-compress ALL old-gen blocks (marked or not)
- Last resort before GC at 100%
- Ensures batch cleanup catches everything before GC's blind truncation

### Merge-compress implementation

New function in `lib/gc/truncate.ts` (or new file `lib/gc/merge.ts`):

```ts
function mergeMarkedBlocks(
    state: SessionState,
    markedIds: number[],
    maxMergedLength: number, // e.g., maxOldGenSummaryLength or configurable
): { mergedCount: number; savedTokens: number }
```

1. Collect all marked blocks (sorted by blockId ascending = oldest first)
2. Concatenate their summaries with separators
3. If concatenated length > maxMergedLength: truncate (keep headers, cut middle)
4. Create new CompressionBlock with merged summary
5. Deactivate all source blocks (set active=false, set deactivatedByBlockId=newBlockId)
6. New block covers all effectiveMessageIds from source blocks
7. Clear markedForCleanup set
8. Persist state

### Config additions

In `lib/config.ts`, add to `gc` config section:

```ts
gc: {
    // ... existing fields ...
    batchCleanup: {
        lowThreshold: "60%",      // nudge tier
        highThreshold: "75%",     // auto merge-compress tier
        forceThreshold: "90%",    // force merge all old blocks
    },
}
```

All optional with defaults. Backward compatible (missing = use defaults).

### System prompt update

In `lib/prompts/system.ts`, add mark_block to the tools documentation:

```
mark_block(blockId: "b0") — Mark a compressed block for batch cleanup.
Zero immediate effect — the block stays in context with full cache hits.
Marked blocks are merge-compressed together when context pressure rises,
minimizing cache breaks. Use this for blocks whose information you no longer
need but don't want to delete immediately (to preserve cache).

unmark_block(blockId: "b0") — Remove the cleanup mark from a block.
```

## Data flow

```
Model calls mark_block("b0")
  → state.prune.messages.markedForCleanup.add(0)
  → persist state
  → return "marked"

[Several turns later, context at 75%]

Message transform hook runs:
  → runMajorGC() (existing, age-based — still active)
  → runBatchCleanup():
    → currentUsage >= highThreshold (75%)
    → mergeMarkedBlocks(state, [0, 1, 2])
      → concatenate b0+b1+b2 summaries
      → create b3 with merged summary
      → deactivate b0, b1, b2
      → clear markedForCleanup
    → one cache break (same as any compression)
  → prune() — injects b3 summary instead of b0+b1+b2
```

## Cache impact analysis

| Scenario                | Cache breaks | When                                                        |
| ----------------------- | ------------ | ----------------------------------------------------------- |
| mark_block (any time)   | 0            | Never modifies context                                      |
| Tier 1 nudge (60%)      | 0            | Only appends to last message (cache already breaking there) |
| Tier 2 auto merge (75%) | 1            | One break at merged block position                          |
| Tier 3 force (90%)      | 1            | One break at merged block position                          |
| GC at 100% (existing)   | 1            | One break at truncation point                               |

Total: maximum 1 cache break per pressure cycle (vs multiple if discarding individually).

## Files to modify

| File                       | Change                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `lib/state/types.ts`       | Add `markedForCleanup: Set<number>` to PruneMessagesState   |
| `lib/gc/truncate.ts`       | Add `mergeMarkedBlocks()` + `runBatchCleanup()` functions   |
| `lib/hooks.ts`             | Call `runBatchCleanup()` in message transform pipeline      |
| `index.ts`                 | Register `mark_block` (and optionally `unmark_block`) tools |
| `lib/config.ts`            | Add `batchCleanup` config with 3 thresholds                 |
| `lib/config-validation.ts` | Validate new config fields                                  |
| `lib/prompts/system.ts`    | Document mark_block tool                                    |
| `lib/state/persistence.ts` | Ensure markedForCleanup set is serialized/deserialized      |

## Backward compatibility

- `markedForCleanup` defaults to empty Set — old state files without it work fine
- `batchCleanup` config is optional — old configs without it use defaults
- GC remains fully functional — no changes to existing GC behavior
- mark_block tool only registered if config allows (can be disabled)
