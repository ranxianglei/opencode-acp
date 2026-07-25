# REQ: Inactive Block Fixes

## Problem

Two issues with inactive (consumed/GC'd/user-decompressed) compression blocks:

1. **decompress rejects inactive blocks**: `resolveBlockTarget` in `lib/compress/decompress.ts`
   rejects any block where `activeBlocks.length === 0` with "not active. It may have already been
   decompressed." — even for standalone inactive blocks that are safe to decompress. The model sees
   the block's compress call in context but cannot decompress it.

2. **acp_status hides inactive blocks**: `scope:"compressed"` only iterates `activeBlockIds`,
   completely hiding consumed/GC'd blocks. The model cannot discover blocks that were consumed by
   secondary compression, making it impossible to reason about the full compression history.

## Fix

1. **decompress**: Remove the "not active" rejection in `resolveBlockTarget`. Keep the nested
   redirect (consumed blocks inside an active parent still redirect to the parent). Standalone
   inactive blocks (user-decompressed, GC'd, orphaned) can now be decompressed.

2. **acp_status**: Show ALL blocks from `blocksById` (not just active ones). Add `[inactive]`
   marker to the metadata line (not the topic line). Add "N active, M inactive/consumed" summary.

## Files

- `lib/compress/decompress.ts` — remove "not active" rejection
- `lib/compress/status.ts` — show all blocks, add inactive marker
- `tests/acp-status.test.ts` — 3 new tests (inactive visibility, user-decompressed, no marker on active)
- `tests/decompress-logic.test.ts` — 2 new tests (standalone inactive, consumed with active ancestor)
