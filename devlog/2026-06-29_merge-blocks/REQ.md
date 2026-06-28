# REQ: merge-blocks Command

## Problem
Sessions accumulate many small compressed blocks (e.g., 435 blocks in model-editing session). The model can't easily merge them because:
- It doesn't know compress can cover existing blocks
- mark_block is deferred + one-at-a-time (8 calls for 8 blocks)
- It doesn't know block message ranges
- Eventually gives up and focuses on actual task

## Solution
Three changes:

### 1. `/acp merge-blocks` Command
Usage: `/acp merge-blocks 421-428` or `/acp merge-blocks 421,422,423`
- Parses block IDs from args (ranges + lists)
- Looks up blocks in state.prune.messages.blocksById
- Finds message range from anchorMessageId fields
- Creates merged summary by concatenating block topics + summaries
- Creates new CompressionBlock covering the entire range
- Sets consumedBlockIds to deactivate old blocks
- Calls syncCompressionBlocks to apply

### 2. Enhanced Block List Display
When listing blocks (≤20 case), include topic per block:
`b1: "Proxy cost analysis", b2: "Awork deployment"`

### 3. Nudge Text Update
When blockCount > 50, guide to use merge-blocks:
`🔀 Use /acp merge-blocks <range> to merge adjacent blocks.`

## Acceptance Criteria
- [x] `/acp merge-blocks` parses ranges and lists
- [x] Merged block deactivates old blocks via consumedBlockIds
- [x] Enhanced block list shows topics
- [x] Nudge text guides to merge-blocks when >50 blocks
- [x] typecheck clean
- [x] tests pass
- [x] build success
