# DESIGN — Visible-ID Segment Guidance

## Problem

The injected visible-id guidance was a single contiguous span. Compression creates
holes; the span hid them. The model selected refs inside holes and `compress` failed.

## Design

### Data model

```ts
interface VisibleSegment {
    startRef: string      // "m00003"
    endRef: string        // "m00007" (== startRef for single-message segments)
    count: number         // messages in this contiguous run
    tokens: number        // summed len/4 token estimate across the run
    hasTool: boolean      // true if any message in the run carries a non-text part
}
```

Segments are **disjoint** and **exhaustive** over surviving (ref-bearing) messages.
A hole between two segments = messages consumed by a compression block; those refs are
NOT in any segment, so the model cannot pick them.

### Pipeline

```
messages ──► buildVisibleSegments ──► VisibleSegment[] ──► formatVisibleGuidance ──► string
                                         (ascending)            (truncate if > cap)
```

Both functions are pure and exported for unit testing. `injectVisibleIdRange` is now a
thin wrapper that appends the formatted string to the suffix message.

### Token / hasTool estimation

Reuses the same `len/4` heuristic as `estimateContextComposition` (utils.ts). A part
with `type !== "text" && type !== "reasoning"` counts as a tool part and sets
`hasTool=true`. This keeps segment heuristics consistent with the Breakdown line
emitted in the same hook.

### Truncation strategy

When `segments.length > maxVisibleSegments`:

1. Rank a copy: `hasTool DESC` then `tokens DESC`.
2. Take top `maxVisibleSegments` into a keep-set (by object identity).
3. Re-filter the **original ascending** array through the keep-set → preserves timeline
   order in the output.
4. Emit `+N omitted (~K tokens, M msgs)` so the model knows the elision happened.

Why `hasTool` first: tool-bearing segments are the high-value compression targets, and
dropping them would hide exactly the ranges the model most needs to see. Token magnitude
breaks ties among same-category segments.

Why ascending display order (not priority order): the Breakdown line (already emitted
in the same hook) highlights largest tool/code/text ranges with token counts — that is
the "what to compress" signal. The Visible line's job is "which refs are valid"; for
that, timeline order is clearer and avoids confusing the model about causality.

### Config

`compress.maxVisibleSegments: number` (default 50). Plumbed through:
- `CompressConfig` interface (config.ts)
- default config (config.ts)
- `mergeConfig` (config.ts)
- allowed keys + type/range validation (config-validation.ts)
- JSON schema (dcp.schema.json)

### Backward compatibility

No persisted-state change. The injected string format changed
(`[Visible messages: first to last (N)]` → `[Visible: seg, seg, … (N msgs, M segments)]`),
but this string is ephemeral (regenerated every transform) and never persisted. No
migration needed.

### Cost

`buildVisibleSegments` is O(messages × parts) — same order as the existing
`estimateContextComposition` already running in this hook. `formatVisibleGuidance`
truncation sort is O(segments log segments); segments ≤ messages, typically << 100.
Net hook cost increase is negligible.

### What is NOT changed

- `compress/search.ts` rejection logic — still correctly refuses consumed refs. The fix
  is purely on the *guidance* side: stop advertising consumed refs as valid.
- Breakdown line, Top blocks hint, nudge text — untouched.
- `injectMessageIds` (per-message mNNNNN tagging) — untouched.
