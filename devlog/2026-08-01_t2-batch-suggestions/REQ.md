# REQ: Document multi-entry compress format for block-based compression

## Problem

The compress tool supports two usage modes: single entry and multiple entries
(`content` array). The system prompt already documented both for message-based
compression, but only showed single-entry for block-based (T2/T3) compression.
The T2/T3 trigger nudge also only showed single-entry.

When 70+ T1 blocks accumulated (issue #256), the model only knew the single-entry
format and tried to compress everything into one summary — risking
`maxSummaryLengthHard` overflow.

## Solution

Document both formats in two places:

1. System prompt (`system.ts`): add multi-entry example to MULTI-TIER section
2. T2/T3 trigger nudge (`inject.ts`): add multi-entry format alongside single-entry

No threshold hints — the model decides how to split based on block sizes and topics.

## Scope

- `lib/prompts/system.ts`: add multi-entry format example
- `lib/messages/inject/inject.ts`: add multi-entry format to tier trigger text
