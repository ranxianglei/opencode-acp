# REQ: Remove lastUserIdx guard from hideConsumedCompressCalls

## Problem

When T1 and T2 compression happen in the same agentic turn (no user message between them), `hideConsumedCompressCalls` fails to hide the consumed T1 compress call. The `lastUserIdx` guard breaks the loop at the last user message, skipping all messages after it — including the T1 compress call that was made after the user message but before the T2 compress call.

Result: T1 summary stays visible + T2 summary is added → context grows instead of shrinking. The model reports "越压越大" (bigger with each compression).

## Root Cause

`lib/compress/hide-consumed.ts` line 43: `if (lastUserIdx >= 0 && i >= lastUserIdx) break`

In OpenCode's agentic loop, multiple tool calls can happen between two user messages. The message layout for same-turn T1+T2:

```
messages[N]:    user message           ← lastUserIdx = N
messages[N+1]:  assistant → T1 compress  ← i=N+1 >= N → BREAK, never processed
messages[N+2]:  T1 tool result
messages[N+3]:  assistant → T2 compress
```

## Fix

Remove the `lastUserIdx` guard entirely. The function is already scoped to only target consumed blocks (inactive + deactivatedByBlockId !== undefined + has compressMessageId). Active blocks' compress calls are never in `consumedMessageIds`, so they're never touched regardless of position.

## Impact

- Files changed: `lib/compress/hide-consumed.ts` (removed lastUserIdx + unused import)
- New tests: `tests/hide-consumed.test.ts` (4 tests)
- Risk: Low — only affects consumed blocks, active blocks untouched
