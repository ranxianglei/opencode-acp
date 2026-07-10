# WORKLOG: Remove size-based recommendations from nudge

## Date: 2026-07-11

## Branch: `2026-07-11_nudge-remove-recommendations`

## Changes

### `lib/messages/inject/inject.ts`

**Removed** from `injectCompressNudges` (lines 249-257):
- `composition.largestToolRanges.slice(0, 10)` → "Largest tool outputs:" listing
- `composition.largestCodeRanges` → "Largest code messages:" listing
- `composition.largestMessageRanges` → "Largest text messages:" listing

These listings caused the model to compress by size (directive) rather than
by need (self-assessment).

**Replaced** (line 258):
- Old: `💡 Compress incrementally: target the ranges above whose content you have already extracted for this step. Size alone is not a reason to compress — if a large range is still needed in full, keep it.`
- New: `💡 Use \`acp_status\` or review the context above to identify consumed content. Prefer compressing large continuous ranges by work phase — not small incremental steps. Convert verbose tool outputs into concise summaries rather than keeping raw content.`

**Simplified** `toolOutputReminder` (lines 214-219):
- Removed `topRanges = composition.largestRanges.slice(0, 15)` listing
- Replaced: `⚠️ X new tool outputs accumulated (Y total). Use \`acp_status\` or review the context above to identify and compress consumed ranges. Prefer large continuous ranges by work phase — convert tool outputs into concise summaries rather than keeping raw content.`

**Kept unchanged**:
- Composition ratio breakdown (`tool (40%) | summaries (10%) | code (28%) | text (22%)`)
- Top tools ratio
- Growth signal (`+X since last nudge`)
- `estimateContextComposition()` function — still computes `largestRanges` etc., just not displayed

### `lib/prompts/system.ts`

**Modified** CONTEXT BREAKDOWN section (lines 76-83):
- Line 76: Removed `(largest category — compress first when consumed)` after `"tool" = tool call outputs`
- Lines 81-83: Removed the paragraph listing largest ranges + "Compress incrementally" directive
- Replaced with need-based guidance:
  > The breakdown shows where tokens are spent — it is INFORMATION, not a
  > directive. Use `acp_status` or review the context above to identify which
  > content you have already consumed. When compressing, prefer large
  > continuous ranges by work phase (e.g. m00150–m00220) rather than small
  > incremental steps — small compressions create overhead that can exceed
  > their savings. Convert verbose tool outputs into concise summaries: most
  > useful content in tool calls should become part of a summary, not kept
  > as raw, lengthy output. Each compression creates a reusable summary block
  > you can decompress later if needed.

## Verification

- `npm run typecheck`: 0 errors
- `npm run test`: 609 tests pass, 0 failures
- No test files reference the removed text strings

## Rationale

Analysis of session `ses_0e1951573ffeWOaARblvet5U7s` showed 93-99% compression
when the model compressed by work phase (user-directed), vs. the "context leak"
pattern (grow 5%, compress 2%) when following ACP's size-based "Largest tool
outputs" recommendations. The model already has per-message token annotations
— it doesn't need ACP to list ranges for it. When ACP lists ranges, the model
treats the list as a directive and compresses by size, not by need.
