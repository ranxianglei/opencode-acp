# REQ: Issue #23 — ACP Context Memory Leak Fix

## Problem

ACP's model-driven compression has a structural leak: context grows 5%,
model compresses 2%, net positive, eventually overflows. Root causes:

1. **Baseline leak after compress**: Compress drops context to 78K, model
   continues working to 150K in the same turn. Each transform re-establishes
   the nudge baseline to the inflated 150K instead of the post-compression 78K,
   leaking 72K of headroom. Next nudge needs 200K instead of 128K.

2. **Size-based recommendations cause fragment compression**: The nudge's
   "Largest tool outputs" listing causes the model to compress by size (wrong)
   instead of by work phase (correct). Results in many small blocks with
   structural overhead exceeding savings.

3. **Missing content preservation mechanism**: Model over-summarizes because
   it can't precisely retype large content. Key details (file paths, function
   signatures, error messages) get lost.

4. **`toolOutputReminder` bypasses adaptive threshold**: Uses a hardcoded
   5000-token growth check, firing ~10x too often on 1M-context models.

5. **Compress detection misses continuation**: Only checks the LAST assistant
   message for compress calls. When model continues after compress
   (`[assistant(compress)] → [tool_result] → [assistant(continuation)]`),
   detection fails and baseline never resets.

6. **Multi-block notification empty summary**: `buildCompressionSummary`
   checks full summary length before truncation, causing early break and
   returning only "... and N more".

7. **Baseline persistence race**: `writePersistedSessionState` resolves
   file path AFTER `await fs.mkdir()`, causing fire-and-forget saves to
   write to the wrong directory when `XDG_DATA_HOME` changes.

## Solution

### KEEP/REF Markers

Two marker types the model can embed in compress summaries:

1. `[[KEEP:mNNNNN]]` — Auto-expand: system replaces with formatted original
   message content inline. Truncated to `compress.keepEmbedMaxChars`
   (default 2000).
2. `[[REF:mNNNNN|description]]` — Compact link `[→ m00065: description]`.
   No expansion. Model can `decompress` later.

### Compressible Ranges Listing

Replaces size-based "Largest code/text messages" with need-based ranges
grouped by conversation turn. Shows ALL ranges (no limit), with gap
detection (no ranges spanning compressed holes).

### Compression Philosophy (5 bullets)

- All compression serves the primary task, but be frugal
- Context capacity is precious — compress consumed outputs, don't avoid tools
- Compress by need, not by percentage
- Work from summaries, not raw tool outputs — compress ALL listed ranges
- Curate summaries with KEEP/REF markers for critical content

### Baseline Leak Fix (`compressBaselineSet` lock)

- On first compress detection: set baseline to `currentTokens`, lock flag
- Subsequent transforms in same turn: skip (lock prevents inflation)
- New turn: release lock, baseline corrects downward to actual level
- Turn-wide scan: `messages.slice(currentTurnStart).some(...)` instead of
  checking only last assistant message

### Other Fixes

- Remove `toolOutputReminder` (was bypassing adaptive threshold)
- `acp_status` default = compressible ranges view
- Debug nudge: `config.debug: true` → terminal output via `sendIgnoredMessage`
- `baselineCorrected` save condition (persistence fix)
- Bug 14 cap: detailed notification summary capped at 10K chars
- System prompt: 5 fixes (acp_status description, protected tools, etc.)

## Files

- `lib/compress/keep-markers.ts` — NEW: marker parsing + resolution
- `lib/messages/inject/utils.ts` — `buildCompressibleRanges` + `formatCompressibleRanges`
- `lib/messages/inject/inject.ts` — compressBaselineSet lock, philosophy, ranges
- `lib/compress/range.ts` — `resolveKeepMarkers` call
- `lib/compress/status.ts` — acp_status ranges view default
- `lib/prompts/compression-rules.ts` — `COMPRESS_PHILOSOPHY` constant
- `lib/prompts/system.ts` — 5 system prompt fixes
- `lib/state/types.ts` — `compressBaselineSet` in Nudges
- `lib/state/state.ts` — init/load flag
- `lib/state/persistence.ts` — persist flag
- `lib/state/utils.ts` — resetOnCompaction flag
- `lib/ui/notification.ts` — Bug 14 cap + multi-block fix
- `lib/hooks.ts` — debug nudge callback
- `lib/config.ts` + `lib/config-validation.ts` — `keepEmbedMaxChars`
- `lib/prompts/compress-range.ts` — KEEP/REF docs
- `tests/inject.test.ts` — 7 tests updated for new baseline behavior
- `tests/keep-markers.test.ts` — NEW: 7 tests
- `tests/acp-status.test.ts` — ranges view tests
