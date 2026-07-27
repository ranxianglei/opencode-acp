# WORKLOG: Debug Mode — Inject Compression Notification into Chat Session

## Change

`lib/ui/notification.ts` — `sendCompressNotification()` (line 309-321):

Added `if (config.debug)` block that calls `sendIgnoredMessage()` to inject the notification text into the chat session BEFORE the toast. This gives a persistent, user-visible, model-invisible record of each compression event when debug mode is active.

The `dropEmptyMessages` backstop in `lib/messages/utils.ts:238` (called at the end of the transform pipeline in `hooks.ts:267`) strips the ignored-only message before the next LLM call, preventing the FIX #20 provider 400 error.

Non-debug behavior is unchanged — toast only.

## Verification

- Build ✅ | Typecheck ✅ | 929 unit tests ✅
