# Worklog: Principle-Driven Compression Prompts

## Session Summary (commits f47e383 → 8d22f7c)

### Core Philosophy Change
Replaced verbose context-management guidance (CONTEXT PRESSURE LEVELS, 7-item priority list, DO NOT RE-COMPRESS rules) with **4 concise principles** injected every turn:

1. All compression serves the primary task, but be frugal.
2. Context capacity is precious — compress waste promptly.
3. Save context by compressing consumed outputs, not by avoiding tools.
4. Compress by need, not by percentage.

### system.ts (72→15 lines)
- Removed: CONTEXT PRESSURE LEVELS, WHAT TO COMPRESS FIRST (7-item list), DO NOT RE-COMPRESS, WHAT TO COMPRESS CAREFULLY, BEFORE/AFTER COMPRESSING
- Added: 4 principle-driven sentences
- Fixed: Tag format `` / `` wrapping

### utils.ts (buildContextUsageGuidance)
- Removed: All guidance text ("Be frugal", "Extract and keep what matters", pressure level descriptions)
- Removed: Percentage display (no longer shows "X%")
- Now returns: Just "Context: XK tokens." + 4 principles

### inject.ts — Hybrid Tips Frequency
- **Light Tips (💡)**: Show every turn when context ≥15% and below minContextLimit
- **Warning Tips (⚠️)**: Show at key nodes only (first crossing threshold or 10pp growth)
  - 45-55% (minContextLimit): "⚠️ Context is growing..."
  - 55%+ (maxContextLimit): "⚠️ Context limit reached — compress now." + compress call format
- Reset warning tracking when context drops below warning zone
- Removed: `shouldInjectPerMessageNudge` dead function
- Removed: `hardNudgeContextPercent` parameter (merged into minContextLimit/maxContextLimit)
- Removed: `perMessageNudgeGrowthPercent` for light Tips
- Fixed: `usageTag` no-op template `${rawUsage}` → `rawUsage`

### nudge.ts (buildCompressedBlockGuidance)
- Removed: Consolidation suggestion
- Added: Block token counts in list — `b50 (76t), b51 (88t), ...`

### range.ts + message.ts (compress tools)
- Changed: Read `maxSummaryLengthHard` from config instead of hardcoded 3000
- Added: `summaryMaxChars` optional parameter for per-call override

### decompress.ts
- Added: `toFile` optional parameter — writes content to file without inflating context
- Fixed: Windows path validation — `os.tmpdir()` + `path.relative()` instead of hardcoded `/tmp/` + `startsWith(dir+"/")`

### config.ts
- Added: `minNudgeContextPercent` (default 15) — Tips start showing
- Removed: `hardNudgeContextPercent` (replaced by minContextLimit/maxContextLimit)
- Removed: `perMessageNudgeGrowthPercent` (light Tips show every turn)
- Changed: `maxSummaryLength` default 200 → 2000
- Changed: `maxSummaryLengthHard` default 3000 → 4000

### dcp.schema.json
- Removed: `hardNudgeContextPercent`, `perMessageNudgeGrowthPercent`
- Updated: Default values aligned with config.ts

### config-validation.ts
- Removed: Validation blocks for deleted parameters

## Verification
- typecheck: 0 errors
- tests: 496 pass, 0 fail
- build: 330KB
