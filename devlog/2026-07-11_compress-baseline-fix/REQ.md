# REQ: Fix compress baseline tracking bug

## Problem

When the model calls `compress`, `injectCompressNudges` detected the compress
and set `lastPerMessageNudgeTokens = currentTokens`. But `currentTokens` comes
from `getCurrentTokenUsage()` which reads the LAST assistant message's API
token count — the message that CALLED compress, seeing PRE-compression context.

So if context was 100K before compress and dropped to 50K after, the baseline
was recorded as 100K. Next transform: `growth = 50K - 100K = -50K`, looking
like "no growth", so nudges never fired.

The baseline correction logic (`currentTokens < baseline - nudgeGrowthTokens`)
only fired when compress saved more than `nudgeGrowthTokens` (50K on 1M models).
Smaller compressions left the baseline stuck at the pre-compression value.

## Solution

Set `lastPerMessageNudgeTokens = undefined` on compress detection. The next
message-transform run re-establishes the baseline from the real post-compression
API token count (lines 197-202), without triggering a nudge.

## Files Changed

- `lib/messages/inject/inject.ts` — 3-line fix (compress baseline → undefined)
- `tests/inject.test.ts` — 3 tests updated for new baseline behavior
