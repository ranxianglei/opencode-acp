# WORKLOG: Smart Compression Prompts

## Changes

### 1. `lib/prompts/system.ts` — Rewrote compression philosophy
- Removed "Manage context continuously" → Changed to "primary goal is completing the task"
- Added CONTEXT PRESSURE LEVELS (qualitative: Ample/Moderate/High — no hardcoded percentages)
- Added WHAT TO COMPRESS FIRST (bash output, dead-end exploration, redundant tool results)
- Added WHAT TO COMPRESS CAREFULLY (secrets/keys, file paths, function signatures, errors, user preferences)
- Added BEFORE COMPRESSING IMPORTANT CONTENT (verify persisted externally)
- Added AFTER COMPRESSING (generate recovery breadcrumbs + mention decompress for recovery)

### 2. `lib/messages/inject/inject.ts` L182-213 — Tiered context usage injection
- Old: Always "use the compress tool proactively to manage context quality" regardless of usage
- New: Shared `buildContextUsageGuidance()` from utils.ts, config-driven thresholds
  - Below minContextLimit (default 45%): "Context is ample — focus on your task"
  - Between min/max (45-55%): "Context is moderate — compress completed sections"
  - Above maxContextLimit (55%): "Context is high — compress aggressively but selectively"

### 3. `lib/messages/inject/utils.ts` L360-410 — Shared tiered logic
- Exported `buildContextUsageGuidance()` replaces old private `buildContextUsageInfo()`
- Added `resolveThresholdPercent()` helper to parse `number | "NN%"` config values
- Both inject.ts and utils.ts now call the same shared function

## Verification
- TypeScript: clean
- Build: success (301.02 KB)
- Tests: 386/386 pass
