# REQ: Add system token breakdown to acp_status and nudge

## Problem

`acp_status` overview and the nudge breakdown line only showed tool/text/code/summary
token proportions — never system prompt tokens. The system prompt (AGENTS.md, tool
definitions, etc.) can be 5-15K tokens, a significant context portion. Without it,
the model lacks a true big-picture view of total context usage.

## Fix

1. `estimateContextComposition` now returns `systemTokens`, calculated from the
   first assistant message's API-reported `input + cache.read + cache.write` minus
   first user message tokens. Included in `total`.
2. `acp_status` overview header changed from "VISIBLE CONTEXT (uncompressed)" to
   "CONTEXT BREAKDOWN", and breakdown line now starts with `system (N%)`.
3. Nudge breakdown line prepends `system (N%)` when system tokens > 0.
4. `compressibleTokens` calculation subtracts `systemTokens` (system prompt is
   not compressible).

## Files

- `lib/messages/inject/utils.ts` — added `systemTokens` to `ContextComposition` + calculation
- `lib/compress/status.ts` — added `estimateSystemTokens`, show in overview
- `lib/messages/inject/inject.ts` — show system in nudge breakdown, subtract from compressible
- `tests/stats-command.test.ts` — updated header assertion
