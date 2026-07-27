# WORKLOG — Soften Protected Zone (Recent Messages)

## Implementation

### 1. Default change: `preserveRecentMessages` 20 → 5
- `lib/config.ts:244` — changed default

### 2. New function: `filterProtectedRecentMessages`
- `lib/compress/protected-content.ts` — follows exact `filterLastUserMessage` pattern
- Computes protected zone (last N messages + last N tokens) inline
- Filters out protected message IDs from `selection.messageIds`
- Checks `compress.lastSegmentSoftBlock === false` for bypass

### 3. Wiring in range.ts + message.ts
- Added `filterProtectedRecentMessages` to the filter chain (after `filterLastUserMessage`)
- Removed `checkProtectedRange` call from both files
- Removed `checkProtectedRange` from imports

### 4. Test updates (3 tests in soft-block.test.ts)
- Line 111: renamed (was "fails without dangerous", now "all-protected range fails (soft-filter removes everything)")
- Line 135: rewritten (was "dangerous: true succeeds", now "mix of protected+unprotected: unprotected compressed, protected filtered")
- Line 186: rewritten (was "error mentions protected IDs", now "ALL-protected range: filtered out error")

### `checkProtectedRange` in pipeline.ts
- Function remains in codebase but is now dead code (not called anywhere)
- Can be removed in a future cleanup

## Verification
- 922/922 tests pass
- Typecheck clean
- Built + deployed to local opencode
- `filterProtectedRecentMessages` verified in deployed bundle (3 occurrences)
