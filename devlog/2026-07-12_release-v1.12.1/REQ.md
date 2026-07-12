# REQ: Release v1.12.1

## Version
1.12.0 → 1.12.1

## Source
PR #119 (branch `2026-07-12_post-compress-ranges`) — merged to master.

## Changes
- CRITICAL: Register `acp_context_recap` as real tool — fixes compression recap injection
- `stripStaleCompressCalls` — removes compress tool-call parts from previous turns
- KEEP/REF regex normalization (`m150` → `m00150`)
- `resolveKeepMarkers` in message mode
- Toast notification `replace()` fix
- Notification range display (`→ Range: b20: m00150–m00155`)
- Proportional baseline adjustment after compress
- Revert `postCompressRangesShown` (caused over-compression chains)
- Oracle review: 0 CRITICAL, 2 WARN addressed (test coverage + stale TODOs)

## Verification
- 638 tests pass, typecheck OK
- Runtime verified: 37 recaps all `type: tool`, 0 compress calls in API context
