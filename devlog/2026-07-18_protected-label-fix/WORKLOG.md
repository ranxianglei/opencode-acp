# WORKLOG: Protected Label Fix

## Changes

### `lib/messages/inject/utils.ts`
- Added imports: `isToolNameProtected`, `getFilePathsFromParameters`, `isFilePathProtected` from `../../protected-patterns`
- Fixed `buildCompressibleRanges` protected message loop (lines 779-800):
  - **Before**: `if (toolName) tools.add(toolName)` — collects ALL tool names
  - **After**: only adds tool names that match `protectedTools` (via `isToolNameProtected`) or `protectedFilePatterns` (via `isFilePathProtected`)

### `tests/protection-aware-stats.test.ts`
- Added test: "buildCompressibleRanges only lists tools that trigger protection, not all tools in message"
  - Message with `skill` + `grep` + `read` tools, `protectedTools = ["skill"]`
  - Asserts `tools` contains `skill`, does NOT contain `grep` or `read`

## Verification

- TypeScript: 0 errors
- Tests: 751/751 pass (750 existing + 1 new)
- Node v25.9.0
