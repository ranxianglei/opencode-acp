# WORKLOG — /acp Command Fix (Issue #285)

## Changes

### `lib/hooks.ts`
- Removed `compressPermission` early-return gate that blocked ALL commands when permission was "deny"
- Added `handleExportCommand` import from `./commands/export`
- Added `workingDirectory` to `commandCtx` (export needs cwd for default output path)
- Added `/acp export` dispatch with arg parsing
- Added `/acp help` dispatch (also default when no arguments)
- Added `buildHelpText()` function listing available commands

### `lib/commands/export.ts`
- New file (was untracked in main repo, never committed)

### `README.md` + `README.zh-CN.md`
- Removed 4 stale commands: `manual`, `compress`, `decompress`, `recompress`
- Added `export` command with option syntax

### `AGENTS.md`
- Updated module map (commands directory listing)
- Updated data flow diagram (command subcommands)

### `tests/hooks-permission.test.ts`
- Updated permission-deny test: informational commands now work regardless of compress permission

## Verification

- TypeScript: 0 errors
- Tests: 954 pass, 0 fail

## Follow-up (2026-08-17): bare /acp shows status (aligned with pi-acp)

- pi-acp's `/acp` (no args) shows the full status report (same handler as `/acp-status`)
- Bare `/acp` now shows compression status (same as `/acp stats`) instead of help text; `/acp help` shows the command list
- `buildHelpText()`: `/acp` line updated + new `/acp help` line
- README.md / README.zh-CN.md command table: `/acp` row updated
- tests/hooks-permission.test.ts: comment updated (behavioral assertion unchanged)
