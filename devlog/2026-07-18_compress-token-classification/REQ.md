# REQ: Compress Tool Token Classification Fix

## Problem

Since v1.12.9 (compress-as-anchor, PR #153), compression summaries live inside `compress` tool calls' `summary` parameter instead of synthetic recap messages. However, `estimateContextComposition` (`lib/messages/inject/utils.ts`) still classifies ALL tool part tokens as `toolTokens`, including the `compress` summary content.

This causes:
1. **Inflated `tool%`**: compress summary text (~1-5K tokens each) counted as tool overhead
2. **Deflated `summary%`**: summary tokens not tracked at all
3. **Misleading context breakdown**: the nudge shows e.g. `12.3K tool (90%) | 0.1K summaries (1%)` when the real distribution has significant summary content
4. **Suboptimal compression decisions**: model sees wrong category distribution, may misjudge what to compress

## Root Cause

`estimateContextComposition` line 652-661 (pre-fix):
```typescript
} else if (part.type === "tool") {
    const raw = JSON.stringify(part)
    const tokens = Math.round(raw.length / 4)
    msgTotal += tokens
    toolTokens += tokens  // ← ALL tool tokens, including compress summary
    msgTool += tokens
    ...
}
```

The `compress` tool input has structure:
- Range mode: `{ topic, content: [{ startId, endId, summary }] }`
- Message mode: `{ topic, content: [{ messageId, summary }] }`

The `summary` field (typically 500-5000 chars per entry) is semantically summary content, not tool structural overhead.

The old `isSummary` detection (line 622-624) checked for `msg_dcp_summary` prefix and `[Compressed conversation section]` text — both were v1.12.1 synthetic recap markers, now dead code. This is kept for backward compat (old sessions may still have synthetic recap messages).

## Fix

In the tool part branch of `estimateContextComposition`, when `toolName === "compress"`, extract `summary` text from `part.state.input.content[].summary` and reclassify it as `summaryTokens`. The structural overhead (tool name, topic, startId, endId, state output, etc.) remains as `toolTokens`.

## Acceptance Criteria

- [x] Compress tool `summary` content classified as `summaryTokens`
- [x] Compress tool structural overhead classified as `toolTokens`
- [x] Multiple content entries summed correctly
- [x] Malformed compress parts (no `state.input`) fall back to all-tool classification
- [x] Non-compress tools unaffected
- [x] `total = toolTokens + summaryTokens + messageTokens` invariant holds
- [x] `toolTypeBreakdown` for `compress` shows structural overhead only
- [x] All 730 tests pass
- [x] Typecheck clean
