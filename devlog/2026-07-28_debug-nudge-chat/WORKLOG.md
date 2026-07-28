# WORKLOG: Debug Nudge Chat Visibility

1. Created branch `2026-07-28_debug-nudge-chat` from master
2. Imported `sendIgnoredMessage` from `./ui/notification` in hooks.ts
3. Modified `debugNotify` callback to call `sendIgnoredMessage` with full nudge text prefixed `[ACP Debug Nudge]`
4. Verified: typecheck ✅, build ✅, 917 tests ✅
