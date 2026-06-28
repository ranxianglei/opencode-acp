# WORKLOG: merge-blocks Command

## Branch
`ranxianglei/2026-06-29_merge-blocks` from master

## Changes

### New File
- `lib/commands/merge-blocks.ts` (350 lines) — merge-blocks command implementation
  - Parses block ID args (ranges: `421-428`, lists: `421,422,423`)
  - Resolves blocks from state.prune.messages.blocksById
  - Creates merged summary from block topics + summaries
  - Creates new CompressionBlock with consumedBlockIds
  - Calls syncCompressionBlocks to deactivate old blocks

### Modified Files
- `lib/commands/help.ts` — Added merge-blocks to help text
- `lib/commands/index.ts` — Registered merge-blocks command
- `lib/hooks.ts` — Wired merge-blocks command handler
- `lib/prompts/extensions/nudge.ts` — Enhanced block list (show topics) + merge guidance (>50 blocks)
- `tests/nudge-text.test.ts` — Updated tests for enhanced block list

## Verification
- typecheck: clean (exit 0)
- tests: all pass (0 fail)
- build: success
