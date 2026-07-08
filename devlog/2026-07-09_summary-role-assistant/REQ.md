# REQ: Summary Role — Always Assistant

## Problem

Compression summaries were sometimes injected as `role: "user"` when the next
surviving message after a pruned range was a user turn. The model could then
misattribute its own prior compression recap as a user instruction.

This was the Bug 36 "merge into user" path, which merged the summary text into
the following user message's text part, giving it `role: "user"`.

## Root Cause

`filterCompressedRanges()` in `lib/messages/prune.ts` had two paths:

1. **Merge path** (Bug 36 fix): If the next surviving message was `role: "user"`,
   `prependCompressionSummary()` merged the summary into that user message.
   Result: model sees summary text with `role: "user"`.

2. **Standalone path** (Bug 37 fix): Otherwise, `createSyntheticMessage(...,
   "assistant")` created a standalone assistant message. Result: model sees
   summary text with `role: "assistant"`.

Bug 36 originally rejected the standalone path because `AssistantMessage`
required fields that a synthetic message lacked. Bug 37 solved this by teaching
`createSyntheticMessage` to fabricate safe defaults. The merge path was therefore
no longer necessary but remained as a source of role confusion.

## Solution

Remove the merge path entirely. All compression summaries are now standalone
`role: "assistant"` synthetic messages, regardless of what follows.

## Scope

- `lib/messages/prune.ts`: Remove dual-path logic, always use standalone assistant
- `lib/messages/utils.ts`: Dead code cleanup deferred (prependCompressionSummary,
  MERGED_SUMMARY_HEADER/FOOTER remain as unused exports — harmless, cleanup TBD)
- `tests/prune.test.ts`: 3 tests updated for standalone assertions
- `tests/e2e-message-transform.test.ts`: 3 tests updated for standalone assertions

## Acceptance Criteria

1. All compression summaries emitted as `role: "assistant"`
2. No summary text appears in surviving user messages
3. No consecutive user turns introduced
4. All tests pass
5. Bug 28 (stale ref stripping) still works on standalone summaries
