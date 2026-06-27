# DESIGN: Prune cache fix

## Current Architecture

```
hooks.ts:createChatMessageTransformHandler
  → prune(state, logger, config, messages)     ← runs EVERY request
      → filterCompressedRanges(...)              ← rebuilds array (OK: only when blocks change)
      → pruneToolOutputs(...)                    ← MUTATES part.state.output (BREAKS CACHE)
      → pruneToolInputs(...)                     ← MUTATES part.state.input  (BREAKS CACHE)
      → pruneToolErrors(...)                     ← MUTATES error outputs     (BREAKS CACHE)
```

## After Fix

```
hooks.ts:createChatMessageTransformHandler
  → prune(state, logger, config, messages)
      → filterCompressedRanges(...)              ← still runs, handles compression
      // pruneToolOutputs — DISABLED (prefix cache breaker)
      // pruneToolInputs  — DISABLED (prefix cache breaker)
      // pruneToolErrors  — DISABLED (prefix cache breaker)
```

## Why This Is Safe

1. **Compression still works**: `filterCompressedRanges` is the actual compression
   mechanism. When the model calls `compress`, blocks are created, and
   `filterCompressedRanges` replaces old messages with summaries. This is independent
   of `pruneToolOutputs`.

2. **Context growth is bounded**: Without pruning, tool outputs stay full until
   compression triggers (at ~55% context limit). The model sees the large context,
   ACP nudges it, and the model calls `compress`. This is the intended flow.

3. **Net token savings**: Cache hits on full tool outputs (cheap) vs cache misses
   from pruning (expensive re-sends of 120K-450K tokens). The math favors keeping
   outputs cached.

## Related Work

- Issue #5: Same class of bug (nudge injection modifying historical messages).
  Fixed by moving dynamic content to a suffix message. The prune pipeline was
  not addressed at that time.
- PR #13: Added `mark_block` tool (unrelated — mark_block was never called).

## Future Improvement

Move tool pruning to a suffix-message approach (like the issue #5 nudge fix):
instead of replacing `part.state.output`, append "stale tools: call_xxx" to the
suffix message. The model sees the staleness note and can compress those tools.
This preserves both pruning AND cache stability.
