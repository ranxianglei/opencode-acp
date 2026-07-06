# REQ — Visible-ID Segment Guidance

## Background

Issue #9 ("调查这个压缩失败可能原因" / investigate possible compress-failure causes)
identified that the `compress` tool frequently fails because the model picks a
message ref that lives inside an already-compressed hole.

Root cause: `injectVisibleIdRange` (lib/messages/inject/inject.ts) emitted a single
contiguous span `[Visible messages: m00001 to m00950 (810 messages)]`. When compression
blocks consumed messages in the middle of that span, the injected span still advertised
the consumed refs as valid. The model, trusting the span, requested
`startId/endId` inside a hole. `compress/search.ts` then rejected the call
("message m00xxx is already consumed by block bN"), and compression aborted.

## Reproduction

1. Run a long session until at least one compression block exists mid-conversation.
2. Observe the suffix-message tag: `[Visible messages: m00001 to m00950 (810 messages)]`.
3. When the model is nudged to compress, it picks refs from the advertised span.
4. ~half the time the picked range overlaps a compressed hole → compress fails.

## Constraints

- Must NOT change persisted state format (backward compat, AGENTS.md §2.6).
- Must NOT change the `compress` tool schema or search semantics.
- Token cost of the new guidance must stay bounded even with hundreds of segments.
- Output format must remain machine-scannable and model-legible.
- No `as any` / `@ts-ignore` (AGENTS.md hard blocks).

## Acceptance Criteria

- [x] Visible-id guidance shows **disjoint segments**, never a single span that
      crosses a compression hole.
- [x] Segments are rendered in ascending ref order (timeline clarity).
- [x] When segments exceed a configurable cap, only the highest-value (tool-bearing /
      high-token) are shown; the rest are summarized as `+N omitted`.
- [x] New config `compress.maxVisibleSegments` (default 50) with validation + schema.
- [x] Pure-function unit tests for segment building, formatting, truncation, ordering.
- [x] Existing e2e test updated to the new format; full suite green (modulo known
      pre-existing bun-incompat in prompts.test.ts).
- [x] `tsc --noEmit` clean. `tsup` build succeeds.

## Approach

Rewrite `injectVisibleIdRange` into three pure, unit-testable pieces:

1. `buildVisibleSegments(state, messages)` — walk surviving messages, map each to its
   ref + token/hasTool signature, sort refs numerically, fold contiguous refs into
   maximal segments.
2. `formatVisibleGuidance(segments, maxSegs)` — render the `[Visible: ...]` string.
   When `segments.length <= maxSegs`, show all in ascending order. Otherwise rank by
   `hasTool DESC, tokens DESC`, keep the top `maxSegs`, and re-project the kept set
   back into ascending order for display (drops the smallest, preserves timeline).
3. `injectVisibleIdRange` — thin wrapper that wires (1)+(2) to the suffix message.

Config plumbing: `CompressConfig.maxVisibleSegments`, default in `config.ts`, merge in
`mergeConfig`, validation in `config-validation.ts`, JSON schema in `dcp.schema.json`.
