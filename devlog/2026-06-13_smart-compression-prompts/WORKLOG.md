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

### 4. Iteration 2: Anti-re-compression + tool-output-first guidance

**Trigger**: Observed agent repeatedly compressing already-compressed block summaries (300 tokens each) with negligible effect. Context stayed at ~53% despite 5+ compressions.

**Changes to `lib/prompts/system.ts`**:

- Added principle: "Target the largest UNCOMPRESSED content first"
- Expanded WHAT TO COMPRESS FIRST with recoverable high-token content types
- New section: DO NOT RE-COMPRESS (low value, diminishing returns)

### 5. Iteration 3: Dual Oracle review fixes

**Trigger**: Dual Oracle review found 1 CRITICAL + 7 MAJOR issues.

**Fixes applied**:

- **CRITICAL**: Agent results bullet — removed "compress immediately" (contradicted pressure-based philosophy), explained protected tools auto-preservation behavior, made decompress primary recovery path (not re-invoke)
- **MAJOR**: DO NOT RE-COMPRESS — added aging warning exception (nudge.ts tells model to re-summarize aging blocks; system prompt must not contradict)
- **MAJOR**: Merged 4 redundant bullets (terminal/build/git/publish) into one "Verbose command output" bullet
- **MAJOR**: "Content needed in next 2-3 turns" → "Content whose immediate use is complete" (models can't predict future)
- **MAJOR**: Build/test output — keep failure messages + file/line refs, not just verdict (contradicted compress-range.ts EXHAUSTIVE requirement)
- **MINOR**: Added missing scenarios — resolved discussion threads, pending tool calls guard
- **MINOR**: Removed specific agent names (Oracle, explore, librarian) — use generic phrasing

## Verification

- TypeScript: clean
- Build: success
- Tests: 386/386 pass
