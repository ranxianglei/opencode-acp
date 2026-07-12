# WORKLOG

## Branch: `2026-07-12_post-compress-ranges`
## Base: `github/master` (v1.12.0)

### Three-Tier Strategy

#### Tier 1: Nudge Guidance
- Added after compressible ranges in nudge:
  `💡 Compress all ranges in one call if possible (pass multiple content entries). If you need this list after compressing, call acp_status.`

#### Tier 2: Post-Compress One-Time Fallback
- `postCompressRangesShown: boolean` flag in Nudges state
- Shows remaining ranges ONCE after first compress in a turn
- Never shows again until new turn resets the flag
- Gated by `overMinLimit` — only when context is still high enough
- Debug: sends to terminal via `debugNotify` callback
- Format: `[Post-compress — shown once] N ranges remaining (~XK). Compress all at once, or call acp_status to re-fetch`

#### Tier 3: On-Demand via acp_status
- Already available since v1.12.0
- Model can call `acp_status({scope:"uncompressed"})` for ranges view

#### Notification Range Display
- `formatEntryRanges(entries, state)` in `lib/ui/notification.ts`
- Converts block startId/endId to mNNNNN refs
- Added `→ Range: b20: m00150–m00155` line

### Files Changed
- `lib/messages/inject/inject.ts`
- `lib/ui/notification.ts`
- `lib/state/types.ts`
- `lib/state/state.ts`
- `lib/state/persistence.ts`
- `lib/state/utils.ts`

### Verification
- 630 tests pass, 0 failures
- typecheck OK
- Deployed to local cache (8 matches for `postCompressRangesShown`)
