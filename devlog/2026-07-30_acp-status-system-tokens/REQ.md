# REQ: Add system token breakdown to acp_status and nudge

## Problem

`acp_status` overview and the nudge breakdown line only showed tool/text/code/summary
token proportions — never system prompt tokens. The system prompt (AGENTS.md, tool
definitions, etc.) can be 5-15K tokens, a significant context portion. Without it,
the model lacks a true big-picture view of total context usage.

Additionally, the context fill percentage ("Context: 47% full.") was leaked to the
model, which made it lazy about compression — the model would see "47% full" and
think context is healthy, delaying compression unnecessarily.

## Fix

1. `estimateContextComposition` now returns `systemTokens`, calculated from the
   first assistant message's API-reported `input + cache.read + cache.write` minus
   first user message tokens. Included in `total`.
2. `acp_status` overview header changed from "VISIBLE CONTEXT (uncompressed)" to
   "CONTEXT BREAKDOWN", and breakdown line now starts with `system (N%)`.
3. Nudge breakdown line prepends `system (N%)` when system tokens > 0.
4. `compressibleTokens` calculation subtracts `systemTokens` (system prompt is
   not compressible).
5. Removed context fill percentage leak — `buildContextUsageGuidance` no longer
   emits "Context: X% full." text. Category proportions (tool 40%, text 22%) are
   kept because they help the model prioritize compression without revealing total
   fill level.
6. Deleted dead code: `buildContextUsageGuidance` (was returning ""), its sole
   caller `injectContextUsage`, and the tautological test.
7. Extracted shared `estimateSystemPromptTokens()` into `token-utils.ts` using
   the real Anthropic tokenizer (was `length/4` — 2-4x inaccurate for CJK).
   Consolidated 4 duplicate implementations into 1.

## Files

- `lib/token-utils.ts` — added shared `estimateSystemPromptTokens()` with typed accessor
- `lib/messages/inject/utils.ts` — use shared helper, deleted dead `buildContextUsageGuidance`
- `lib/compress/status.ts` — use shared helper (was local `estimateSystemTokens`)
- `lib/messages/inject/inject.ts` — show system in nudge breakdown, subtract from compressible,
  deleted dead `injectContextUsage` + import
- `tests/inject-utils-pure.test.ts` — added 4 positive tests for system token estimation
- `tests/nudge-text.test.ts` — removed tautological test + unused constants
- `tests/stats-command.test.ts` — updated header assertion
