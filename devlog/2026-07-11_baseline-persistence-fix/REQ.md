# REQ: Persist baseline re-establishment + fix async save race condition

## Problem

After PR #99 fixed the baseline bug (compress sets `lastPerMessageNudgeTokens = undefined`),
a follow-up issue was discovered: the baseline is re-established in memory on the next
transform, but **never persisted to disk** because the save condition
(`anchorsChanged || decision.shouldNudge`) is false on the re-establishment turn.

After restart, the on-disk state still has `lastPerMessageNudgeTokens: null`, so nudges
never fire again.

Additionally, a race condition was found in `writePersistedSessionState`: the file path
was resolved AFTER `await ensureStorageDir`, by which point `XDG_DATA_HOME` may have
changed (especially in tests that switch temp dirs between cases).

## Solution

1. Add `baselineReEstablished` flag — set when baseline transitions from `undefined` to
   a real value. Include in the save condition.
2. Capture file path synchronously before any `await` in `writePersistedSessionState`.

## Files Changed

- `lib/messages/inject/inject.ts` — `baselineReEstablished` flag + save condition
- `lib/state/persistence.ts` — capture file path before await (race condition fix)
