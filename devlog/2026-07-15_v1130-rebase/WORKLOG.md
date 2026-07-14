# WORKLOG: v1.13.0 Rebase + Three Bug Fixes

## Branch
`2026-07-15_v1130-rebase` — rebased from `2026-07-14_remove-gc-compress-anchor`
onto latest master (after PRs #139, #140, #143, #144 merged).

## Changes

### Bug #1: Token Counting (`lib/messages/inject/utils.ts`, `lib/messages/query.ts`)

**`lib/messages/query.ts`**: Added `hasCompressToolPart(message)` — checks if
any part has `type === "tool" && tool === "compress"`. Broader than existing
`messageHasCompress` (which requires `role === "assistant"` + `status === "completed"`).

**`lib/messages/inject/utils.ts`** — `estimateContextComposition`:
- Added `hasCompressToolPart` import.
- Added `isCompressCall = hasCompressToolPart(msg)` detection.
- `isSummary` now includes `isCompressCall ||` before existing checks.
- Tool part handler: when `isSummary`, tool tokens → `summaryTokens` instead of
  `toolTokens`.

**`lib/messages/inject/utils.ts`** — `buildCompressibleRanges`:
- Added `if (hasCompressToolPart(msg)) continue` after `isSyntheticMessage`
  check. Compress tool calls are anchors, not compressible.

### Bug #2: Anchor Presence Check (`lib/messages/sync.ts`)

Removed L53-66 (anchor presence check that deactivated blocks when compress
tool call message missing). Removed `[PATCH Bug 3]` comment. Removed dead
`missingOriginBlockIds` variable + `missingOriginCount` log field. Updated log
condition.

Blocks now stay active based on:
1. `deactivatedByUser` flag (user decompress)
2. `consumedBlockIds` (nested compression)

### Bug #3: Summary Fallback (`lib/messages/emergency-prune.ts`)

Added `EMERGENCY_PRUNE_SUMMARY_STUB` constant. Added fallback loop after tool
output pruning loop: if `tokensSaved < targetReduction`, iterates messages
before `lastUserIdx`, finds compress tool parts (`part.tool === "compress"`),
replaces `state.input` with stub. Idempotent check via `rawInput.includes()`.

### Tests Updated

- `tests/sync.test.ts`: 4 tests inverted — blocks now stay active when anchor
  deleted (compress-as-anchor).
- `tests/inject-utils-pure.test.ts`: +1 test — compress tool call counted as
  summaryTokens. Added `mkCompressCall` helper.
- `tests/keep-markers.test.ts`: +1 test — compress tool calls excluded from
  compressible ranges. Added `compressPart` helper.
- `tests/emergency-prune.test.ts`: +3 tests — summary fallback fires, idempotent,
  skips after-last-user. Added `compressToolPart` helper.

## Verification

- TypeScript: PASS
- Tests: 660 pass (655 + 5 new), 0 fail
- Build: success (379K)
