# WORKLOG

## Branch: `2026-07-11_compress-keep-ranges`

### `lib/compress/keep-markers.ts` (NEW)
- `resolveKeepMarkers(summary, messages, state, config)` — Parses `[[KEEP:mNNNNN]]` and `[[REF:mNNNNN|desc]]` markers from summary text
- `formatByType(msg)` — Formats message content by tool type (bash, read, write, edit, etc.)
- `truncate(text, maxChars)` — Truncates with `[truncated, N chars total]` suffix
- Returns `{ summary, expandedCount, refCount, unresolvedRefs }`

### `lib/messages/inject/utils.ts`
- `buildCompressibleRanges(messages, state, maxRanges=15)` — Groups messages by conversation turn (split at user messages with ≥3 msgs). Computes per-turn tokens + composition.
- `formatCompressibleRanges(ranges)` — Formats as:
  ```
  Compressible ranges (oldest first):
    m00050–m00071  22 msgs  17K  [tool 88% | text 12%]
  ```

### `lib/messages/inject/inject.ts`
- Replaced `largestCodeRanges`/`largestMessageRanges` listing with compressible ranges listing
- Kept `largestToolRanges` (top 10) — still useful for quick targeting
- Added KEEP/REF hint when ranges are shown

### `lib/compress/range.ts`
- Added `resolveKeepMarkers()` call after `preparedPlan.finalSummary`, before `wrapCompressedSummary`

### `lib/prompts/compress-range.ts`
- Added KEEP AND REF MARKERS section with usage examples

### Config
- `compress.keepEmbedMaxChars` (default 2000) — max chars per KEEP expansion
- Added to config type, defaults, merge, validation

## Verification
- 630 tests pass, typecheck OK
- 7 new tests in `tests/keep-markers.test.ts`
