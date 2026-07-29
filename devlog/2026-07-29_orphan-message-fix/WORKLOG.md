# WORKLOG: orphan-message-fix

## Changes

1. Added `STRUCTURAL_PART_TYPES = new Set(["step-start", "step-finish", "reasoning"])` constant
2. Changed the post-filter decision in `hideConsumedCompressCalls`:
   - Before: `if (remaining.length > 0)` → keep message
   - After: `if (remaining.some(p => !STRUCTURAL_PART_TYPES.has(p.type)))` → keep message
3. Added 4 tests covering: reasoning+step-finish orphan, reasoning-only orphan, text survives, non-compress tool survives

## Test Results

- 899 tests pass (0 failures)
- Typecheck clean
- 8 hide-consumed tests pass (4 existing + 4 new)
