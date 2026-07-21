# WORKLOG - Remove dead `prune` tool

- Task ID: `2026-07-21_remove-prune-tool`
- Branch: `2026-07-21_remove-prune-tool`
- Status: Done
- Updated: 2026-07-21

## Changes

| File | Change |
|------|--------|
| `index.ts` | Removed `createPruneTool` from import block; removed `prune: createPruneTool(compressToolContext)` from tool registration object |
| `lib/compress/index.ts` | Removed barrel export `export { createPruneTool } from "./prune-tool"` |
| `lib/prompts/system.ts` | Removed `- \`prune\` — Remove old tool outputs...` line from TOOLS section |
| `lib/compress/prune-tool.ts` | Deleted (was 101 lines, now unreferenced) |

## Verification

- `npm run typecheck` — PASS (0 errors)
- `npm test` — PASS (803/803 tests, 0 failures)
- Build not required for non-release PR, but confirmed no dangling imports.

## Notes

- Total surface removed: ~105 lines (1 file deleted + 3 lines of registration
  + 1 line of export + 1 line of prompt).
- No test changes needed — tests for the three stripping functions in
  `lib/messages/prune.ts` still pass because those functions still exist
  (just unused by the pipeline). Removing them is a separate cleanup.
- The strategies (dedup, purgeErrors) still write to `state.prune.tools` —
  the marks simply never get consumed. That behavior is unchanged by this PR.
