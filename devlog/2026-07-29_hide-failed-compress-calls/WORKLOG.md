# WORKLOG: hide-failed-compress-calls

## Changes

### New file: `lib/compress/hide-failed.ts`
- `hideFailedCompressCalls(messages)`: iterates messages, removes `compress` tool parts with `state.status === "error"`. Splices message if all parts removed. Returns count of removed parts.

### Modified: `lib/hooks.ts`
- Import `hideFailedCompressCalls`
- Call after `injectMessageIds` (which is after `injectCompressNudges`) — preserves nudge baseline reset logic.

### Modified: `lib/compress/index.ts`
- Export `hideFailedCompressCalls`

### New test: `tests/hide-failed.test.ts`
- 7 tests: removes error compress parts, splices empty messages, preserves successful compress calls, preserves failed non-compress calls, handles multiple failures across messages, handles empty array, handles no-parts messages.

## Verification
- typecheck: clean
- tests: 890 pass, 0 fail
