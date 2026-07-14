# REQ: v1.13.0 Rebase + Three Bug Fixes

## Problem

PR #138 (`2026-07-14_remove-gc-compress-anchor`) was built on older master.
Since then, PRs #139 (Bug 20 suppression), #140 (growth floor fix), #143 (stale
contextLimitAnchors), #144 (release v1.12.6) were merged. The branch needed
rebasing. During testing of the rebased code, three bugs were found in the
compress-as-anchor architecture:

### Bug #1: Token Counting — Compress Tool Calls Miscategorized

In compress-as-anchor, compression summaries live inside the compress tool
call's `state.input` (the `content[].summary` field). But:
- `estimateContextComposition` counted compress tool calls as `toolTokens`
  instead of `summaryTokens` — the model saw inflated tool usage and deflated
  summary usage in the context breakdown.
- `buildCompressibleRanges` included compress tool calls in compressible ranges
  — the model could try to compress the compress tool call itself, which is the
  anchor, not compressible content.

### Bug #2: sync.ts Deactivates Blocks When Anchor Deleted

`syncCompressionBlocks` had an anchor presence check: if the compress tool call
message (anchor) was missing from the visible messages list, the block was
deactivated. But OpenCode's internal compaction can remove old tool calls
without the user triggering decompress. This caused ALL compressed messages to
suddenly reappear → context overflow.

In compress-as-anchor, `filterCompressedRanges` uses `byMessageId.activeBlockIds`
to hide messages — it does NOT use the anchor position. So the anchor presence
check is unnecessary and harmful.

### Bug #3: Emergency Prune Has No Summary Fallback

`runEmergencyPrune` only stubbed tool outputs. If tool outputs alone couldn't
reach the target reduction, it stopped early. User requirement: tool outputs
first, then compression summaries as last resort.

## Fix

### Bug #1
- `lib/messages/query.ts`: Added `hasCompressToolPart()` helper.
- `lib/messages/inject/utils.ts` (`estimateContextComposition`): Compress tool
  calls now detected via `hasCompressToolPart()`, treated as `isSummary`, tool
  tokens counted as `summaryTokens` not `toolTokens`.
- `lib/messages/inject/utils.ts` (`buildCompressibleRanges`): Compress tool
  call messages skipped entirely (they are anchors, not compressible).

### Bug #2
- `lib/messages/sync.ts`: Removed anchor presence check (L53-66). Blocks stay
  active based on `deactivatedByUser` flag + `consumedBlockIds` only. Removed
  dead `missingOriginBlockIds` variable + log field.

### Bug #3
- `lib/messages/emergency-prune.ts`: Added fallback loop after tool output
  pruning. If `tokensSaved < targetReduction`, iterates messages before
  `lastUserIdx`, finds compress tool calls (`part.tool === "compress"`),
  replaces `state.input` with `[Summary emergency-pruned to prevent context overflow]`.

## Tests

- Updated 4 sync tests to reflect compress-as-anchor (blocks stay active when
  anchor deleted).
- Added 1 `estimateContextComposition` test: compress tool call counted as
  summaryTokens.
- Added 1 `buildCompressibleRanges` test: compress tool calls excluded.
- Added 3 emergency prune tests: summary fallback fires, idempotent, skips
  after-last-user.
