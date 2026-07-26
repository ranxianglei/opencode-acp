# REQ: summaryBuffer over-counting fix

## Problem

`getActiveSummaryTokenUsage()` counts ALL active compression blocks' summary tokens,
regardless of whether those blocks' compress tool calls are still visible in the
current context window.

In long-running sessions (e.g., 448 blocks, 3683 messages), opencode's own
compaction removes old messages — including old compress tool calls. ACP's state
still marks those blocks as active. The function returns 151K tokens instead of
the actual ~6K visible summaries.

## Impact

This inflation feeds into `summaryBuffer` (context limit extension) and nudge
trigger growth computation:

- **False nudge triggers**: Growth appears as 151K → nudge fires every turn
- **False tier 2 triggers**: T1 summary tokens appear >> 50K threshold
- **Misleading stats**: `/acp stats` shows "summary 146%" — impossible
- **Misleading context %**: summaryBuffer extends max limit by 151K instead of 6K

## Solution

Add optional `visibleMessageIds: Set<string>` parameter to
`getActiveSummaryTokenUsage`. When provided (by the inject hook which has the
full message list), only blocks whose `compressMessageId` is in the set are
counted.

Call sites updated:
- `lib/messages/inject/utils.ts` — `isContextOverLimits` passes message IDs
- `lib/commands/stats.ts` — `handleStatsCommand` passes message IDs

## Non-Goals

- `getTierTokenUsage()` in PR #200 has the same bug pattern — will be fixed when
  PR #200 rebases on this fix.
- No behavioral change when `visibleMessageIds` is omitted (backward compat).
