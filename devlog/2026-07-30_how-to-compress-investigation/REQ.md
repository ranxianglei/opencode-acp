# REQ: Re-add HOW_TO_COMPRESS_RULES to nudge injection

## Problem

v1.14.7 (PR #228) removed `HOW_TO_COMPRESS_RULES` from nudge templates and the breakdown block, keeping it only in the system prompt (injected every turn). The rationale was token savings (~2.4-3.6K per nudge turn) and deduplication.

However, in long sessions (8,700+ messages), the system prompt is 12K chars buried at the START of a 1M+ token context. The model's attention to rules in the system prompt degrades significantly — the "lost in the middle" effect. When the nudge fires and the model is about to compress, the detailed summary-writing rules (KEEP VERBATIM, DROP, PRIORITY) are not at high attention where they're needed most.

The nudge message IS at the END of the context (high attention). Before v1.14.7, it contained HOW_TO_COMPRESS_RULES. After v1.14.7, it only contains COMPRESS_PHILOSOPHY (a short 889-char high-level guide) — missing the detailed 4936-char rules for HOW to write good summaries.

## Fix

Re-add HOW_TO_COMPRESS_RULES to the nudge message in two places:

1. **Non-maxLimit path** (`inject.ts:534`): Between COMPRESS_PHILOSOPHY and the compressible ranges list. Only when `recommendedRanges.length > 0` (no point adding rules if nothing to compress).

2. **MaxLimit path** (`inject.ts:545`): In the strong alert tipsText, before the JSON example.

## Tradeoff

+5K chars when a nudge fires (gated by nudgeGrowthTokens — not every turn). Better summaries = fewer recompressions needed = net token savings. The rules appear at HIGH attention (end of context) exactly when the model needs them.
