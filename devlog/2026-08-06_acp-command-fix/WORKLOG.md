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
