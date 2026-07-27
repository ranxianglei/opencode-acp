# REQ: Tier Detection Fix

## Problem

`applyCompressionState` in `lib/compress/state.ts` determined the output tier from
`consumedBlockIds` — if any consumed block existed, the tier went up by 1. This
misclassified T1 compressions that incidentally overlapped existing T1 blocks as T2.

### Evidence

Session `ses_0b89319b1ffeK25eKU3GMfCK8U` (8131 messages, 133 blocks):
- 18 blocks labeled `tier=2`
- **6 are misclassified T1** (directMessageIds > 10, consumed 1 old block incidentally)
- Only 10 are real T2 (0-4 direct messages, consumed blocks via b-prefix boundaries)
- **0 from automatic T2 trigger** — T2 never fired naturally

### Impact

- Misclassified T2 blocks inflate `tier1Tokens` (they're counted as T2, not T1)
- T2 trigger threshold calculation is wrong → may trigger T2 prematurely or miss it
- `acp_status` shows incorrect tier breakdown
- Token counting for tier-based triggers (`getTierTokenUsage`) is inaccurate

## Fix

Tier is determined by **boundary KIND** (`selection.startReference.kind` /
`selection.endReference.kind`), not by whether `consumedBlockIds` is non-empty:

- Both boundaries `"message"` → **T1** (capturing raw messages)
- Either boundary `"compressed-block"` → **T2+** (`max(consumed tier) + 1`)

When T1 compression incidentally consumes an existing T1 block, the old block is
correctly deactivated (its messages are now covered by the new T1 block), but the
new block is labeled tier=1, not tier=2.

## Acceptance Criteria

- [x] T1 compression with message boundaries → tier=1 even when consuming old T1 blocks
- [x] T2 compression with block boundaries → tier=2
- [x] T3 compression with block boundaries consuming T2 → tier=3
- [x] T1 consuming old T1 block → old block deactivated, new block tier=1
- [x] Mixed boundary (message + block) → T2+
- [x] Regression test: 88-msg T1 with incidental T1 overlap → tier=1
- [x] All 929 tests pass
