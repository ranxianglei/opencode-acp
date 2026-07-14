# REQ: Disable in-place tool output pruning to preserve prefix cache

## Problem

`pruneToolOutputs` (prune.ts:73-97) replaces tool call outputs in-place with
`"[Output removed to save context...]"` on **every** `chat.messages.transform`
call. This mutates existing message content, invalidating the LLM provider's
prefix cache from the first modified message onward.

Observed impact (ses_102504697, Jun 25-27):

- 176 cache misses over 2 days, each re-sending 120K-450K tokens
- 89% of fresh input tokens wasted on cache-invalidating re-sends
- ~50M tokens wasted total

This is the same class of bug as issue #5 (nudge injection modifying historical
messages), but in the prune pipeline instead of the nudge pipeline.

## Root Cause

DCP's original design prunes tool outputs by mutating `part.state.output`
directly. ACP's issue #5 fix applied the suffix-message discipline to nudges
but **not** to the prune pipeline.

## Fix

Disable `pruneToolOutputs`, `pruneToolInputs`, and `pruneToolErrors` in the
`prune()` function. These three functions are the only in-place mutation
sources in the prune pipeline. `filterCompressedRanges` (the actual compression
mechanism) is unaffected and continues to handle context reduction.

The model still has the `compress` tool available — when context grows large,
ACP nudges the model to compress, which creates summary blocks processed by
`filterCompressedRanges`. This is the intended context management flow.

## Non-Goals

- Implementing suffix-message-based tool pruning (future PR)
- Modifying `filterCompressedRanges` (it rebuilds the array but only when
  compression blocks change state — infrequent and acceptable)
