# WORKLOG — Debug Nudge Phantom Turn Loop

## Changes

1. `lib/hooks.ts`: Removed `sendIgnoredMessage` from debug nudge callback (lines 205-220). Removed unused import (line 40). Kept `logger.debug` + `showToast`.
2. `lib/ui/notification.ts`: Replaced `sendIgnoredMessage` call with `logger.debug` in debug compress notification block (lines 281-285).

## Verification

- TypeScript: 0 errors
- Tests: 954 pass, 0 fail
- Build: 386.21 KB
- Deployed to `~/.cache/opencode/packages/opencode-acp@latest/`
