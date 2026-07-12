# REQ: Post-Compress Range Visibility + Notification Range Display

## Problem

1. When the model compresses the first range from the compressible ranges
   list, the nudge suffix from the previous turn is ephemeral (gone on next
   transform). The model loses visibility of remaining ranges.

2. Showing remaining ranges EVERY turn after compress causes over-compression
   chains (b36→b37→b38→b39 pattern): model treats "remaining ranges" as
   "should compress" even at low context levels.

3. Compression notifications show block ID but not WHICH message range was
   compressed.

## Solution (three-tier strategy)

### Tier 1: Nudge Guidance (preventive)
- Nudge now suggests: "Compress all ranges in one call (pass multiple content entries). If you need this list after compressing, call `acp_status`."
- The compress tool already supports `content: [{...}, {...}]` batch mode

### Tier 2: Post-Compress One-Time Fallback
- After first compress in a turn, show remaining ranges ONCE
- Flag `postCompressRangesShown` prevents re-showing every turn
- Reset to `false` on new turn (no compress)
- Gated by `overMinLimit` — don't show if context already low
- Debug: print to terminal via `debugNotify` callback

### Tier 3: On-Demand via `acp_status`
- Model can call `acp_status({scope:"uncompressed"})` to re-fetch ranges
- Already available since v1.12.0

### Notification Range Display
- Added `→ Range: b20: m00150–m00155` line to detailed notifications

## Files

- `lib/messages/inject/inject.ts` — one-time post-compress injection + nudge guidance
- `lib/ui/notification.ts` — `formatEntryRanges()` + notification line
- `lib/state/types.ts` — `postCompressRangesShown` in Nudges
- `lib/state/state.ts` — init/load flag
- `lib/state/persistence.ts` — persist flag
- `lib/state/utils.ts` — reset flag on compaction
