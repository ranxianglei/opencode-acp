# REQ: Fork Session Compression State Rebuild

## Problem

When a user forks an ACP-compressed session in OpenCode, the fork session triggers
`context_length_exceeded` because ACP has no compression state for the new session.

OpenCode copies all messages (including completed `compress` tool parts) into the fork,
but regenerates message IDs. ACP's persisted state is keyed off:

1. Session ID (`plugin/acp/{sessionId}.json` — doesn't exist for fork)
2. Raw message IDs (all internal maps use `msg.info.id` — differ in fork)

Result: fork session loads with empty prune state → `filterCompressedRanges` early-returns
→ all 330 messages sent verbatim to the model → context overflow.

Reported: GitHub #89, Gitea #19.

## Solution

**Plan B1: Rebuild from history.** When `ensureSessionInitialized` detects no persisted
state (`persisted === null`), scan message history for completed `compress` tool parts
and replay them to reconstruct `CompressionBlock`s / `byMessageId` /
`activeByAnchorMessageId` using the fork's NEW raw IDs.

### Why this works

Message refs (`m00001`, `m00002`, ...) are assigned sequentially by message order
(`assignMessageRefs`). Fork copies messages in identical order → re-running
`assignMessageRefs` in the fork produces identical refs. Therefore the `startId`/`endId`
refs stored in compress tool inputs point to the same logical messages in both original
and fork.

### Limitations (acceptable)

- Rebuilt summaries use the raw model summary from the tool input, not the enriched
  version (protected-content append happened at original-compress-time and isn't
  re-derived). Protected tool outputs survive in visible context anyway, so no
  information is lost.
- Token accounting stats are approximate (cosmetic, doesn't affect pruning).

## Acceptance Criteria

- [x] Fork session with compress history → rebuilds pruning state → no overflow
- [x] Range-mode and message-mode compressions both rebuilt
- [x] Nested blocks (b1 consumed by b2) correctly deactivated
- [x] Protected tool messages hard-excluded (Bug 39 parity)
- [x] Malformed/incomplete compress parts gracefully skipped
- [x] All existing tests pass (603/604, 1 pre-existing Bun limitation)
- [x] 9 new unit tests pass
- [x] Build + typecheck clean
