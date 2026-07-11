# REQ: KEEP/REF Markers + Compressible Ranges Listing

## Problem

Models over-summarize when compressing — key details (file paths, function
signatures, error messages) get lost because the model can't precisely
retype them in the summary. Additionally, the nudge only recommends the
top 10 largest items by size, missing the "long tail" of many small tool
calls that collectively waste 20K+ tokens.

## Solution

### KEEP/REF Markers

Two marker types the model can embed in compress summaries:

1. `[[KEEP:mNNNNN]]` — Auto-expand: system replaces with formatted original
   message content inline. Truncated to `compress.keepEmbedMaxChars`
   (default 2000). Format by tool type: bash→`$ cmd\noutput`,
   read→output, write/edit→`filePath:\ncontent`.

2. `[[REF:mNNNNN|description]]` — Compact link: becomes
   `[→ m00065: description]`. No expansion. Model can `decompress` later.

Resolution runs after summary is finalized, before `wrapCompressedSummary`.

### Compressible Ranges Listing

Groups visible messages by conversation turn (user message = boundary).
Each range shows: ref span, message count, token estimate, composition %.
Injected into nudge alongside existing breakdown.

## Files

- `lib/compress/keep-markers.ts` — NEW: marker parsing + resolution
- `lib/messages/inject/utils.ts` — NEW: `buildCompressibleRanges` + `formatCompressibleRanges`
- `lib/messages/inject/inject.ts` — Hook ranges into nudge
- `lib/compress/range.ts` — Call `resolveKeepMarkers` before storing summary
- `lib/prompts/compress-range.ts` — Document KEEP/REF in tool prompt
- `lib/config.ts` + `lib/config-validation.ts` — Add `keepEmbedMaxChars`
- `tests/keep-markers.test.ts` — NEW: 7 tests
