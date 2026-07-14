# WORKLOG

## Branch: `2026-07-12_post-compress-ranges`

## Base: `github/master` (v1.12.0)

## Commits: 4

### Commit `ada5906` — feat: post-compress range visibility + notification range display

- Added `formatEntryRanges()` in notification.ts for `→ Range: b20: m00150–m00155`
- Added `postCompressRangesShown` flag + one-time ranges injection after compress
- Updated inject.ts with proportional baseline adjustment + compressBaselineSet lock

### Commit `094212b` — fix: remove post-compress ranges + proportional baseline adjustment

- **REVERTED** `postCompressRangesShown` (caused over-compression chains b36→b37→b38→b39)
- Kept proportional baseline formula: `adjustment = min(1, compressed/growth * 2)`
- Pre-prune token count captured from `hooks.ts:260` (`prePruneTokens`)
- Voluntary compress (no nudge) → baseline unchanged

### Commit `37005f6` — fix: register acp_context_recap tool + strip stale compress calls + KEEP/REF fixes

- **Register `acp_context_recap`** as real tool (`lib/compress/recap.ts`) — fixes compression recap injection
- **`stripStaleCompressCalls`** (`lib/messages/prune.ts`) — removes compress tool-call parts from previous turns
- **KEEP/REF regex normalization** (`keep-markers.ts`) — `normalizeRef()` via `parseMessageRef` + `formatMessageRef`
- **`resolveKeepMarkers` in message mode** (`compress/message.ts`)
- **Toast notification fix** — `displaySummary` hoisted, used as replace target
- **`formatEntryRanges` fix** — use `block.startId`/`endId` directly (already refs, not raw IDs)
- Remove `DETAILED_NOTIFICATION_SUMMARY_MAX_CHARS` — detailed shows full summary

### Commit `1ba9d98` — test: add stripStaleCompressCalls tests + fix stale TODOs (Oracle W1+W2)

- 7 tests in `tests/strip-stale-compress.test.ts`: (a) prev-turn stripped, (b) current-turn preserved, (c) all-compress removed, (d) multiple stripped, (e) no-user no-op, (f) non-compress parts preserved, (g) idempotent
- Replace stale TODOs in `message.ts:191` and `range.ts:275` with implementation pointers

### Oracle Review

- Session: `ses_0a9e7225fffeLEUmfoSEBSs7vG`
- Verdict: 0 CRITICAL, 2 WARN (both addressed)
- All edge cases verified: recap preservation, current-turn preservation, idempotency, ref normalization, toast fix

### Verification

- 638 tests pass (631 + 7 new), 0 failures
- typecheck OK
- Deployed + verified at runtime (37 recaps all `type: tool`, 0 compress calls in context)
- Test design: user instruction "ls /tmp" compressed into recap → model did NOT re-execute → tool-result format confirmed working
