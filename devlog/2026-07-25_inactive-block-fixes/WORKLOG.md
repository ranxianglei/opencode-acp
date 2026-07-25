# WORKLOG: Inactive Block Fixes

## Changes

### lib/compress/decompress.ts
- `resolveBlockTarget` (line ~120): Removed the `return { ok: false, error: "not active" }` branch.
  Previously, when `activeBlocks.length === 0` and no active ancestor was found, decompress was
  rejected. Now, standalone inactive blocks pass through to `{ ok: true, targets: [target] }`.
  The nested-redirect (consumed blocks inside an active parent) is kept — decompressing a consumed
  child directly would restore 0 messages since the parent still claims them.

### lib/compress/status.ts
- `createAcpStatusTool` scope:"compressed" handler (line ~436): Changed block source from
  `activeBlockIds` (active only) to `blocksById.values()` (all blocks). Inactive/consumed blocks
  now appear in the compressed drilldown.
- `renderCompressedDrilldown` (line ~340): Added `[inactive]` marker to the metadata line for
  blocks where `!b.active`. Added "N active, M inactive/consumed" summary line when inactive blocks
  exist. Active blocks get no marker (default state).

### tests/acp-status.test.ts
- 3 new tests:
  - scope=compressed shows inactive/consumed blocks with marker and summary
  - scope=compressed marks user-decompressed blocks as inactive
  - scope=compressed does not add inactive marker to active blocks

### tests/decompress-logic.test.ts
- 2 new tests:
  - findActiveAncestorBlockId returns null for standalone inactive block (the condition that now
    allows decompress to proceed)
  - findActiveAncestorBlockId returns active ancestor for consumed inactive block (the condition
    that still triggers the redirect)

## Verification

- typecheck: pass
- tests: 851 pass (846 existing + 5 new), 0 fail
- build: pass
