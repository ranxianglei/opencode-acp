# REQ: Batch Compress — Per-Entry Topics

## Problem

When the recommendation list shows many compressible ranges, the model faces two failure modes:

1. **Under-compression**: Compresses only one topic, then doesn't know what else to compress (recommendation list disappears after first call).
2. **Quality degradation**: Forces all unrelated ranges under one shared topic to fit in a single call, producing poor summaries.

## Solution

Allow each `content` entry to carry its own optional `topic`. The top-level `topic` becomes optional — it serves as a fallback for entries that don't specify their own.

```
compress({ content: [
  { topic: "Auth", startId: "m10", endId: "m50", summary: "..." },
  { topic: "Deploy", startId: "m60", endId: "m80", summary: "..." },
]})
```

Each entry becomes its own block with its own topic, sharing one `runId` (same tool call). Fully backward compatible: existing calls with top-level `topic` work unchanged.

## Scope

- `lib/compress/types.ts` — `CompressRangeEntry.topic?`, `CompressRangeToolArgs.topic?`
- `lib/compress/range.ts` — schema, execute (per-entry topic resolution)
- `lib/compress/range-utils.ts` — `validateArgs` (entry needs own or fallback), `resolveRanges` (preserve topic)
- `lib/compress/types.ts` — `CompressionStateInput.batchTopic` → `string | undefined`
- `lib/state/rebuild.ts` — per-entry topic resolution in state rebuild
- `lib/prompts/compress-range.ts` — document batch topic in BATCHING section
- `tests/batch-compress.test.ts` — 10 tests (6 validation + 4 integration)
