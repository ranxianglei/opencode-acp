# WORKLOG — Debug Nudge Log Noise Fix

## Changes

`lib/messages/inject/inject.ts`: Moved the recommendation filter `logger.debug` from line 350 (before `shouldInject` decision) to after line 476 (inside `shouldInject` block). Now gated by `shouldInject && config.debug`.

## Verification

- TypeScript: 0 errors
- Tests: 954 pass, 0 fail
- Build: 386.83 KB
- Deployed to `~/.cache/opencode/packages/opencode-acp@latest/`
