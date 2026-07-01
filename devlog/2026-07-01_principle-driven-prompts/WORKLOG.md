# Worklog: Principle-Driven Compression Prompts

## Changes (commit 77098fe, 11 files, +158/-118)

### system.ts (72→27 lines)
- Removed: CONTEXT PRESSURE LEVELS, WHAT TO COMPRESS FIRST (7-item list), DO NOT RE-COMPRESS, WHAT TO COMPRESS CAREFULLY, BEFORE/AFTER COMPRESSING
- Added: 2 failure modes principle (over-compress loses detail, under-compress causes overflow)
- Added: BE FRUGAL section with 5 examples (command output, sub-agent results, training logs, duplicate reads, failed explorations)
- Fixed: Empty backtick tags → `<dcp-message-id>` and `<dcp-system-reminder>`

### utils.ts (buildContextUsageGuidance)
- Removed: All guidance text ("Be frugal", "Extract and keep what matters", pressure level descriptions)
- Now returns: Just "Context usage: XK / 1000K tokens (X%)" — no suggestions

### inject.ts (shouldInjectPerMessageNudge)
- Added: minNudgeContextPercent check (default 15%) — below 15%, no nudge
- Changed: Growth from relative (%) to absolute (percentage points)
- Changed: Default growth threshold 3→10pp
- Tips: Only tool names, no compression commands

### nudge.ts (buildCompressedBlockGuidance)
- Removed: Consolidation suggestion
- Added: Block token counts in list — `b50 (76t), b51 (88t), ...`

### range.ts + message.ts (compress tools)
- Removed: Dual-tier soft/hard limit
- Added: Single 3000-char limit
- Added: `summaryMaxChars` optional parameter for override
- Error: "Add summaryMaxChars parameter to allow longer summaries."

### decompress.ts
- Added: `toFile` optional parameter — writes content to file without inflating context
- Block stays compressed when toFile is used

### config.ts
- Added: minNudgeContextPercent (default 15)

### tests/nudge-text.test.ts
- Updated: All assertions for simplified output

## Config Updates (not in commit)
- acp.jsonc: nudgeFrequency=6, perMessageNudgeGrowthPercent=10
- dcp.jsonc: nudgeFrequency=6, perMessageNudgeGrowthPercent=10

## Verification
- typecheck: 0 errors
- tests: 494 pass, 0 fail
- build: 330KB
