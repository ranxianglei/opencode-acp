# WORKLOG - token-usage-fix

## Commits

1. `fix: getCurrentTokenUsage uses input-only token data (output=0 fix)` — `lib/token-utils.ts` + `tests/token-usage.test.ts`

## Key Changes

### `lib/token-utils.ts`
- **Skip condition** (line 28): Changed from `(output || 0) <= 0` to `input <= 0 && output <= 0`. Assistant messages with `output=0` but `input>0` (aborted/hidden requests) are now used instead of skipped.
- **Fallback estimation** (line 51): Changed from text-only loop to `countAllMessageTokens(m)` which includes tool outputs. Tool-heavy conversations are no longer undercounted in the fallback path.
- Token formula unchanged: `input + cacheRead + cacheWrite + output + reasoning`.

### `tests/token-usage.test.ts`
- 3 new tests:
  1. `getCurrentTokenUsage uses assistant message with output=0 but input>0` — verifies the core fix
  2. `getCurrentTokenUsage skips assistant message with both input=0 and output=0` — verifies truly empty messages are still skipped
  3. `getCurrentTokenUsage fallback counts tool outputs not just text` — verifies improved fallback

## Test Results

- TypeScript: 0 errors
- Build: success (383.73 KB)
- Tests: 669/669 pass (was 666 + 3 new)

## Root Cause Analysis

Session `ses_0a3be0cdeffezb9pLzfifH7lzK` (1M context, GLM-5.2):
- 6 recent assistant messages had `output=0` (finish=other, hidden agent requests/aborts)
- `getCurrentTokenUsage` skipped all 6, fell through to text-only estimation
- Most content was compressed away → estimate ≈ 100K (10% of 1M)
- 10% < 20% minContextLimit → no nudge fired
- 10% < 100% majorGcThreshold → no emergency GC
- Model kept going until API 400 errors (16x)
