# WORKLOG: Smart Compression Prompts

## Changes

### 1. `lib/prompts/system.ts` — Rewrote compression philosophy
- Removed "Manage context continuously" → Changed to "primary goal is completing the task"
- Added CONTEXT PRESSURE LEVELS (Ample <40%, Moderate 40-55%, High >55%)
- Added WHAT TO COMPRESS FIRST (bash output, dead-end exploration, redundant tool results)
- Added WHAT TO COMPRESS CAREFULLY (secrets/keys, file paths, function signatures, errors, user preferences)
- Added BEFORE COMPRESSING IMPORTANT CONTENT (verify persisted externally)
- Added AFTER COMPRESSING (generate recovery breadcrumbs with file paths, signatures, rationale)

### 2. `lib/messages/inject/inject.ts` L182-213 — Tiered context usage injection
- Old: Always "use the compress tool proactively to manage context quality" regardless of usage
- New: Three tiers based on actual usage percentage:
  - <40%: "Context is ample — focus on your task. Only compress obvious waste."
  - 40-55%: "Context is moderate — compress completed sections and high-token waste."
  - >55%: "Context is high — compress aggressively but selectively."

### 3. `lib/messages/inject/utils.ts` L360-380 — Same tiered logic
- Applied identical three-tier guidance to the `buildContextUsageInfo()` function used in anchored nudges

## Verification
- TypeScript: clean
- Build: success (301.02 KB)
- Tests: 386/386 pass
