# REQ: Compress-as-anchor (remove synthetic recap injection)

## Goal

Remove the synthetic `acp_context_recap` tool-result injection. Keep compress tool calls visible in context as natural anchors instead.

## Problem

The synthetic recap (`createSyntheticToolRecap`) created a single AssistantMessage with one completed ToolPart. The model saw this as a malformed tool-call — "only input, no output." This confused the model and caused it to echo/hallucinate.

## Solution

Instead of injecting synthetic recaps, let the original compress tool calls serve as natural anchors. They already have both input (the summary) and output (the confirmation), so they're well-formed. Compressed messages are simply hidden via `filterCompressedRanges`.

## Changes

### Source
1. `lib/hooks.ts`: Removed `stripStaleCompressCalls()` call — compress tool calls stay visible.
2. `lib/messages/prune.ts`: Simplified `filterCompressedRanges()` to only hide compressed messages. Removed recap injection logic, `computeBlockCoverage`, `stripStaleCompressCalls`.
3. `lib/messages/utils.ts`: Removed `createSyntheticToolRecap()` and `ACP_RECAP_TOOL_NAME` (dead code).
4. `lib/messages/index.ts`: Removed `stripStaleCompressCalls` export.
5. `lib/messages/sync.ts`: Updated stale comment.
6. `lib/compress/range.ts`, `lib/compress/message.ts`: Removed stale comments.
7. `lib/prompts/system.ts`: Updated "COMPRESSION SUMMARIES" section to reference past compress tool calls instead of `acp_context_recap`.

### Tests
- `tests/prune.test.ts`: Rewrote 5 tests (assert no recap injection), removed 4 obsolete tests (recap-specific features).
- `tests/e2e-message-transform.test.ts`: Rewrote 3 tests (assert no recap injection).
- `tests/message-priority.test.ts`: Removed 2 obsolete tests (block ID marking in recap output).
- `tests/sync.test.ts`: Updated stale comment.
- `tests/strip-stale-compress.test.ts`: Deleted (entire file tested removed function).
