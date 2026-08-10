# REQ: hide-consumed callID-aliasing leak under batched compress (issue #288)

## Problem

`hideConsumedCompressCalls` keyed its keep-set on `compressCallId`, which is a
**1:N** key under batched `compress` calls: one tool invocation with multiple
`content[]` entries creates multiple `CompressionBlock`s that all share a single
`compressCallId`.

When a higher-tier (T2) distillation consumes only SOME sibling blocks in a
batch, the surviving sibling keeps the shared `compressCallId` in the
active-keep-set. That rescues the WHOLE tool part, including the summaries of the
already-consumed siblings — so those summaries leak back into context
permanently. They are also **unreclaimable**: `compress` is in the default
`protectedTools` list, so no later compression can touch them.

Reported upstream: https://github.com/ranxianglei/opencode-acp/issues/288
Real-session impact (from the report): 209 blocks / 176 unique callIds / 31
sharing groups; 2 mixed-liveness groups wasting ~2379 tokens permanently.

Same defect exists in `acp-kernel` `src/hide-consumed.ts` (separate PR).

## Acceptance criteria

- [x] A batched compress call where SOME sibling blocks are consumed: the tool
      part is kept, but its `state.input.content` is rewritten to drop the
      consumed entries' summaries (live entries retained).
- [x] All siblings live → part kept unchanged (no spurious rewrite).
- [x] All siblings consumed → part fully removed (existing behavior preserved).
- [x] Regression test that FAILS with the pre-fix code and passes after.
- [x] `npm run build` + `tsc --noEmit` + full test suite (957) green.
- [x] No change to orphaned-call (last-2) behavior.

## Non-goals

- Changing the semantics of the `hidden` return count (still counts fully-removed
  parts; rewrites are not counted — both call sites ignore the value anyway).
- Message-mode (none in this version; range-mode only).
