# WORKLOG: Disable GC memory loss

## Changes

### `lib/hooks.ts` — `runMajorGC` simplified

**Removed** (~40 lines):
- Age-based deactivation loop (`for ... if age > maxBlockAge → deactivate`)
- `hasOversizedBlocks` detection + override (scanned all active blocks for `summary.length > 6000`)
- Complex trigger: `if (!shouldRunMajorGC && !hasOversizedBlocks) return`

**Added**: 4-line comment explaining why code was removed (prevents re-introduction via git blame).

**Result**: `runMajorGC` is now a pure threshold-gated truncation:
```
if (!modelContextLimit) return
if (!shouldRunMajorGC(currentTokens, modelContextLimit, gc)) return
// ... collect old blocks, truncate to maxOldGenSummaryLength
```

### `lib/config.ts` — default `maxBlockAge`

Changed from `15` → `Number.MAX_SAFE_INTEGER` with inline comment noting it's a no-op. The field stays in the schema for backward compat (existing user configs with `maxBlockAge` won't error).

### `tests/e2e-blocks-nudges.test.ts` — aging test inverted

Test was: "block aging: old blocks are deactivated by major GC" — set `maxBlockAge: 2`, block with `survivedCount: 10`, asserted `active === false`.

Now: "block aging: old blocks are NOT deactivated (age-based GC disabled)" — same setup, asserts `active === true`. The `maxBlockAge: 2` override is now ignored.

## Verification

- TypeScript: 0 errors
- Tests: 757/757 pass (Node v25.9.0)
- Build: clean

## Risk

Low. The removed code paths caused silent memory loss. Keeping them provided no benefit (the model's summaries are already compact). The 100% context emergency path is preserved.
