# DESIGN: Fork Session Compression State Rebuild

## Architecture

New module: `lib/state/rebuild.ts` — pure function `rebuildCompressionState(state, messages, config, logger)`.

### Data flow

```
ensureSessionInitialized (state.ts)
  └─ persisted === null (fork detected)
      └─ rebuildCompressionState(state, messages, config, logger)
          ├─ assignMessageRefs(state, messages)     ← build mNNNNN → rawId map
          ├─ collectCompressInvocations(messages)    ← scan for completed compress parts
          └─ for each invocation (chronological):
              ├─ buildSearchContext(state, messages) ← rebuild each iteration
              │                                       (so earlier blocks visible for bN refs)
              ├─ [range mode] rebuildRangeInvocation
              │   ├─ resolveRanges (all entries at once)
              │   ├─ filterProtectedToolMessages (Bug 39)
              │   ├─ extractBoundaryConsumedBlocks + dedupe
              │   └─ per-entry: allocateBlockId → wrapCompressedSummary → applyCompressionState
              └─ [message mode] rebuildMessageInvocation
                  └─ per-entry: resolve → allocateBlockId → wrapCompressedSummary → applyCompressionState
```

### Key design decisions

**1. Refs are fork-stable.** `assignMessageRefs` assigns `m00001...` by message order.
Fork has identical order → identical refs. This is the foundational insight that makes
rebuild possible without any ID-mapping heuristics.

**2. Reuse existing resolution functions.** `resolveRanges`, `resolveBoundaryIds`,
`resolveSelection`, `applyCompressionState` are called directly — ensuring the rebuilt
state is structurally identical to what the original compress produced.

**3. Chronological processing with per-invocation searchContext rebuild.** Each
compress invocation is replayed in message order. `buildSearchContext` is rebuilt before
each invocation so that blocks created by earlier invocations are visible for `bN`
boundary resolution (nested compression).

**4. Mirror the original pipeline ordering.** Within a single range invocation, all
entries are resolved BEFORE any block is created (mirrors `range.ts`). This ensures
entries within the same call can't reference each other's blocks.

**5. Config is optional.** `ensureSessionInitialized` gains `config?: PluginConfig`.
Rebuild only runs when config is provided (production paths). Existing tests that call
`ensureSessionInitialized` without config are unaffected (old behavior — no rebuild).

**6. Graceful degradation.** Each invocation and each entry is wrapped in try/catch.
Malformed parts, resolution failures, or unexpected states skip gracefully — partial
rebuild is better than none.

### Files changed

| File | Change |
|------|--------|
| `lib/state/rebuild.ts` | **NEW** — rebuild logic (350 lines) |
| `lib/state/state.ts` | `ensureSessionInitialized` + `checkSession` gain optional `config` param; rebuild call in `persisted === null` branch |
| `lib/hooks.ts` | Pass `config` to `checkSession` and `ensureSessionInitialized` |
| `lib/compress/pipeline.ts` | Pass `ctx.config` to `ensureSessionInitialized` |
| `lib/compress/decompress.ts` | Pass `ctx.config` to `ensureSessionInitialized` |
| `tests/rebuild.test.ts` | **NEW** — 9 unit tests |

### Backward compatibility

- `config` param is optional → no breaking change to `ensureSessionInitialized` API
- No changes to persisted state format, internal tags, or exported APIs
- No changes to the compress tool itself — rebuild only reads history
