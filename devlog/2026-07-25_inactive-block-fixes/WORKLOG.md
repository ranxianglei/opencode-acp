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
- tests: 859 pass (846 existing + 13 new across 4 commits), 0 fail
- build: pass

## Round 2 dual-agent review findings (fixed in commit 4)

### Fixed: toFile writes garbage for inactive blocks
`lib/compress/decompress.ts:325` — inactive blocks had empty `activeBlocks`, so fallback was
`activeBlocks[0]?.summary` (undefined) → wrote literal `"(no content available)"`. Changed to
`targets[0]?.blocks[0]?.summary` so the block's actual summary is written.

### Fixed: /acp decompress slash command still rejected inactive blocks
`lib/commands/decompress.ts:153-161` — same "not active" rejection existed in the slash command
path. Applied the same fix: keep nested-redirect, drop "not active" rejection.

### Added: E2E tests for actual decompress tool behavior
`tests/inactive-block-decompress.test.ts` — 7 tests exercising the real decompress tool:
- resolveCompressionTarget returns target for inactive block
- decompress tool succeeds for standalone inactive block (actual behavior change)
- decompress tool redirects for consumed block with active parent
- decompress tool works normally for active block (control)
- toFile on inactive block writes summary (not placeholder)
- decompress succeeds when all ancestor chain is inactive (multi-block scenario)
