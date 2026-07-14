# WORKLOG: Tool-Result Recap Injection

## Changes

### `lib/messages/utils.ts`

- Added `ACP_RECAP_TOOL_NAME = "acp_context_recap"` constant
- Added `createSyntheticToolRecap()` — creates AssistantMessage with a completed ToolPart containing the compression summary as `state.output`

### `lib/messages/prune.ts`

- Replaced dual-path injection (merge-into-user + standalone-assistant) with single-path tool-result injection
- Removed: `findNextSurvivingMessage()`, `getLastUserMessage` import, `STANDALONE_SUMMARY_HEADER/FOOTER`, `createSyntheticMessage` import, `prependCompressionSummary` import
- `filterCompressedRanges()` now unconditionally calls `createSyntheticToolRecap()` for each active block at its anchor position

### `lib/prompts/system.ts`

- Updated "COMPRESSION SUMMARIES IN CONTEXT" section: references `acp_context_recap` tool instead of `[ACP SYSTEM METADATA]` tags
- Added explicit anti-echo directive

### Tests updated

- `tests/prune.test.ts` — 4 tests updated to assert tool-result format
- `tests/e2e-message-transform.test.ts` — 3 tests updated
- `tests/message-priority.test.ts` — 2 tests updated to check `tool.state.output` instead of text part

## Verification

- TypeScript: pass (0 errors)
- Build: pass (dist/index.js 363KB)
- Tests: 599/599 pass
