# WORKLOG - Debug notification triggers phantom model turns

- Task ID: `2026-07-15_debug-no-phantom-turn`
- Branch: `2026-07-15_debug-no-phantom-turn`
- Base: `github/master` @ `3fa1415`

## Root Cause

`debugNotify` callback (`lib/hooks.ts:282-292`) was wired to `sendIgnoredMessage()`, which internally calls `client.session.prompt({ body: { noReply: true, ... } })`. opencode does NOT respect `noReply: true` — every call triggers a full model turn.

The debug notification content IS correctly filtered from model context by `isIgnoredUserMessage()` (checks all parts have `ignored: true`). So the model is called with context ending in its own assistant output → hallucinates "user sent a summary of my reply" → responds → triggers another transform hook → another debug notification → infinite loop.

## Fix

Changed `debugNotify` callback from `sendIgnoredMessage(...)` to `logger.debug(...)`. Debug info now goes to `logs/acp/daily/` log file only — no `session.prompt()` call, zero model turns.

### Files changed
1. `lib/hooks.ts:45` — removed `import { sendIgnoredMessage } from "./ui/notification"` (now unused in this file)
2. `lib/hooks.ts:282-292` — callback body: `sendIgnoredMessage(client, sessionId, ...)` → `logger.debug(...)`; gate simplified from `config.debug && state.sessionId` to `config.debug` (logger doesn't need session ID)

## Verification

- TypeScript: 0 errors (`tsc --noEmit`)
- Tests: 713/713 pass (`node --import tsx --test tests/*.test.ts`)
- No test references the debug-notification path (grep confirmed)

## Notes

- `sendIgnoredMessage()` is retained for other notification paths (compression notifications, etc.) — only the debug callback was changed.
- The chat UI no longer shows `[ACP Debug] Nudge injected: ...` messages. Debug filter decisions are now in `~/.config/opencode/logs/acp/daily/<date>.log` only.
