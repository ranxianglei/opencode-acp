# WORKLOG: Persist baseline re-establishment + fix async save race condition

## Date: 2026-07-11

## Branch: `2026-07-11_baseline-persistence-fix`

## Changes

### `lib/messages/inject/inject.ts`

Added `baselineReEstablished` flag:

- Set to `true` when `lastPerMessageNudgeTokens` transitions from `undefined` to a real value (lines 200-206)
- Added to save condition (line 319): `if (anchorsChanged || decision.shouldNudge || baselineReEstablished)`

### `lib/state/persistence.ts`

Fixed race condition in `writePersistedSessionState`:

- Before: `await ensureStorageDir(logger)` then `getSessionFilePath(sessionId)` — path resolved after await
- After: `const filePath = getSessionFilePath(sessionId)` captured synchronously before any await

This prevents fire-and-forget saves from writing to the wrong directory when `XDG_DATA_HOME` changes between scheduling and execution.

## Verification

- `npm run typecheck`: 0 errors
- `npm run test`: 621 tests pass, 0 failures

## Context

Discovered while analyzing session `ses_0b33c32f0ffe3rFc7R5zOeCRvp` which showed
`lastPerMessageNudgeTokens: null` in persisted state despite running the PR #99 fix.
The baseline was correctly set to `undefined` on compress (persisted), but the
re-establishment on the next transform was in-memory only and lost on restart.
