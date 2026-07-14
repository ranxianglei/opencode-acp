# Worklog — Context Optimization

## Changes (8 files, +186/-8 lines)

### Fix 1: Summary length limit (R1)

- **config.ts**: Added `maxSummaryLength` (default 100) to CompressConfig
- **config-validation.ts**: Type + key validation
- **compress/message.ts, compress/range.ts**: Check `summary.length > maxSummaryLength` → throw error before creating block

### Fix 2: Compress tool cleanup (R2) — NOT FEASIBLE

- ToolContext API only allows modifying output/title/metadata, NOT input args
- Added TODO comments in both handlers noting `experimental.chat.messages.transform` as alternative
- Documented for future investigation

### Fix 3: Nudge strengthening (R3)

- **inject/utils.ts**: Guidance text now explicitly mentions ">5000 characters" tool outputs
- Changed from generic "compress tool outputs" to targeted "if any tool output >5000 chars and you've finished reading, compress it into a summary NOW"

### Fix 5: Step marker truncation (R5)

- **prune.ts**: New `stripStepMarkers()` function
    - Skips `step-start` parts entirely (zero-value boundary markers)
    - Truncates `step-finish` reason to 50 chars (was avg 155 chars)
    - Called from `prune()` before context injection
- Estimated savings: ~90K tokens per session with heavy reasoning

### Fix 6: ACP simplification (R6)

- **system.ts**: Pressure level descriptions shortened to 1 sentence each
    - Normal: "Be frugal — compress tool outputs you've finished using into summaries."
    - Elevated: "Context is growing — compress larger ranges you no longer need."
    - Critical: "Compress aggressively now — target the largest visible ranges first."
- **inject/utils.ts**: Per-message guidance reduced from 5+ to 3 sentences
- Block ID list: UNCHANGED (accuracy requirement)

### Fix 7: Minimum compress range (R7)

- **config.ts**: Added `minCompressRange` (default 2000) to CompressConfig
- **config-validation.ts**: Type + key validation
- **compress/message.ts, compress/range.ts**: Calculate total message chars via `countMessageCharacters()` → throw error if < minCompressRange
- **token-utils.ts**: New `countMessageCharacters()` helper

## Verification

- `npm run typecheck`: clean ✅
- `npm run test`: 487 pass, 0 fail ✅
- Block ID list: verified unchanged (empty git diff on nudge.ts)

## Not Implemented

- **Fix 4 (exclude old reasoning)**: Cancelled — causes recurring cache breaks as reasoning crosses age threshold every turn.
- **Fix 2 (compress input cleanup)**: Not feasible with current OpenCode plugin API. Needs `experimental.chat.messages.transform` hook investigation.
