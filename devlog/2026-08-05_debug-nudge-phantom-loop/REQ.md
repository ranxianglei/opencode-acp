# REQ — Debug Nudge Phantom Turn Loop

## Problem

When `config.debug: true`, ACP's debug notifications used `sendIgnoredMessage()` to persist nudge text and compress notifications to the conversation DB as `ignored: true` user messages. opencode's runtime loop detects the last user message by `role == "user"` WITHOUT checking the `ignored` flag, so the phantom user message triggers a new turn → model keeps working → calls compress → another notification → infinite loop.

## Evidence

From issue #20 floor 1734 (awork investigation):
- 867 messages in session, 10 compress calls, 10 `ignored: true` user messages
- Each phantom user message made the runtime loop continue
- Session eventually stopped but was stuck in a loop for extended period

## Fix

Remove ALL `sendIgnoredMessage` calls from debug-mode notification paths:
1. `hooks.ts:205-232` — Debug nudge callback: removed `sendIgnoredMessage`, kept `logger.debug` + `showToast`
2. `notification.ts:281-285` — Debug compress notification: removed `sendIgnoredMessage`, kept `showToast` + added `logger.debug`

Both sites now use `logger.debug` (file log at `~/.config/opencode/logs/acp/`) + `showToast` (5-second popup) for debug visibility, without writing to the conversation DB.
