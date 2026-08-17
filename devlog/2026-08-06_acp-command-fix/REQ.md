# REQ — /acp Command Fix (Issue #285)

## Problem

1. `/acp` (no args) returned nothing when compress permission was "deny" — the global permission gate at `hooks.ts:279` blocked ALL commands, not just compress-triggering ones
2. README listed 6 commands that no longer exist (`manual`, `compress`, `decompress`, `recompress`) — stale from v1.14.x refactor
3. `/acp export` handler existed in `lib/commands/export.ts` but was never wired up in `hooks.ts`
4. No help command to list available commands

## Fix

1. Removed global permission gate from command handler — all `/acp` commands are informational, none trigger compression
2. Added `/acp help` (also default when no args) — lists available commands
3. Wired up `/acp export` in `hooks.ts`
4. Updated README.md + README.zh-CN.md command tables to match actual commands
5. Updated AGENTS.md module map + data flow diagram
