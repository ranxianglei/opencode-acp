# REQ: Disable GC memory loss

## Problem

The GC system was silently destroying compression summaries at low context pressure:

1. **Oversized-block override** (`hooks.ts:169-178`): Any active block with `summary.length > maxOldGenSummaryLength * 2` (6000 chars) triggered truncation to 3000 chars **regardless of context usage**. Model-written detailed summaries (with file paths, signatures, decisions) routinely exceed 6000 chars → silently cut to 3000 at 0% context pressure.

2. **Age-based deactivation** (`hooks.ts:131-163`): Blocks with `survivedCount > maxBlockAge` (default 15) were automatically deactivated, removing their summaries from active context.

### Evidence

State file scan across all sessions found hundreds of `[GC truncated]` markers:
- `ses_0a3be0cde...`: 60 truncated blocks
- `ses_099a16068...`: 47 truncated
- `ses_0f0319702...`: 47 truncated

These summaries were explicitly written by the model to preserve information. GC destroyed them for no benefit (summaries are already small relative to original content).

## Solution

1. **Remove oversized-block override** — truncation now only triggers via `shouldRunMajorGC` (i.e., at `majorGcThresholdPercent`, default 100%).
2. **Remove age-based deactivation loop** entirely — blocks no longer auto-deactivate by age. `gc.maxBlockAge` config field kept for backward compat but is now a no-op.
3. **Update default `maxBlockAge`** from 15 to `Number.MAX_SAFE_INTEGER` (documents the no-op status in config schema).
4. **Keep 100% emergency truncation** — at genuine context exhaustion, truncation still runs as a last resort.

## Acceptance Criteria

- [x] No block truncated below `majorGcThresholdPercent` context usage
- [x] No block deactivated by age regardless of `survivedCount`
- [x] Existing `maxBlockAge` config accepted but ignored (no validation error)
- [x] 100% context emergency truncation still works
- [x] All 757 tests pass
