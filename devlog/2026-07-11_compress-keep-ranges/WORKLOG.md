# WORKLOG

## Branch: `2026-07-11_compress-keep-ranges`

## Commits: 7 (github/master..HEAD)

### Commit History

1. `1e4a92d` feat: KEEP/REF markers + compressible ranges listing
2. `5bca817` fix: add KEEP anti-pattern guidance to compress prompt
3. `3d9c801` fix: move KEEP anti-pattern guidance to HOW TO COMPRESS rules
4. `169e720` fix: compress detection overwrites disk baseline on restart
5. `3a4ed2c` fix: notification summary empty for multi-block compressions
6. `3f5bfbe` feat: inject nudge text to terminal when debug mode is on
7. `3d3def4` fix: baseline leak after compress + Oracle review fixes

### Key Changes by Area

#### KEEP/REF Markers (`lib/compress/keep-markers.ts`)

- `resolveKeepMarkers(summary, messages, state, config)` — Parses markers
- `[[KEEP:mNNNNN]]` → auto-expand original content (truncated to 2000 chars)
- `[[REF:mNNNNN|desc]]` → compact link `[→ mNNNNN: desc]`
- Format by tool type: bash→`$ cmd\noutput`, read→output, write/edit→`filePath:\ncontent`

#### Compressible Ranges (`lib/messages/inject/utils.ts`)

- `buildCompressibleRanges(messages, state)` — Groups by conversation turn
- Gap detection: filters synthetic messages, splits on ref-number gaps
- No maxRanges limit — shows ALL ranges
- `formatCompressibleRanges(ranges)` — `m00050–m00071  22 msgs  17K [tool 88% | text 12%]`

#### Baseline Leak Fix (`lib/messages/inject/inject.ts`)

- `compressBaselineSet: boolean` lock in Nudges state
- First compress detection: set baseline = currentTokens, lock = true
- Subsequent transforms: skip (lock prevents inflation from continuation work)
- New turn: release lock (`compressBaselineSet = false`)
- Turn-wide scan: `messages.slice(currentTurnStart).some(...)` replaces last-message-only check
- `baselineCorrected` flag for save condition (downward correction persistence)

#### Compression Philosophy (`lib/prompts/compression-rules.ts`)

- `COMPRESS_PHILOSOPHY` constant: 5 bullets (frugal/precious/need-based/work-from-summaries/curate-with-KEEP-REF)
- Injected in efficiency nudge after `efficiencyNote`
- Replaces old `buildContextUsageGuidance` inline philosophy

#### Nudge Cleanup (`lib/messages/inject/inject.ts`)

- Removed `toolOutputReminder` (bypassed adaptive threshold, caused over-compression)
- Removed "Largest code messages" and "Largest text messages" listings
- Removed "Compress incrementally, size alone is not a reason" hint
- Replaced with compressible ranges + "compress ALL listed ranges" directive

#### acp_status Enhancement (`lib/compress/status.ts`)

- Default `scope:"uncompressed"` now shows ranges (matches nudge format)
- `view:"messages"` for old per-message listing (size-sorted)
- `tool` filter only works with `view:"messages"`
- Overview includes compressible ranges alongside blocks

#### System Prompt Fixes (`lib/prompts/system.ts`)

1. `acp_status` description: mentions `view:"ranges"` vs `view:"messages"`
2. "lean toward keeping" → "compress ALL listed ranges"
3. Removed "aim for 20+ messages"
4. Protected tools: "appended to summaries" → "hard-excluded"; listed `skill` only
5. "Compress incrementally" → "Each compression creates a reusable summary block"

#### Notification Fixes (`lib/ui/notification.ts`)

- Multi-block: truncate each entry to `perEntryMax = budget/entries.length` before checking total
- Bug 14 cap: `DETAILED_NOTIFICATION_SUMMARY_MAX_CHARS = 10000` for detailed mode

#### Debug Nudge (`lib/hooks.ts`)

- `config.debug: true` → nudge text sent to terminal via `sendIgnoredMessage`
- Optional 7th param `debugNotify` callback to `injectCompressNudges`

#### State Persistence (`lib/state/types.ts`, `persistence.ts`, `state.ts`, `utils.ts`)

- Added `compressBaselineSet: boolean` to Nudges
- Persisted to disk, loaded with `?? false` backward compat
- Initialized in `createSessionState`, `resetSessionState`, `resetOnCompaction`

### Oracle Review Results

- Core fix correct (lock mechanism + turn-wide scan)
- Critical staging issue found and fixed (regressed intermediates in index)
- Bug 14 regression fixed (detailed notification cap)
- Test name fidelity fixed ("post-compression" → "compress-calling assistant")
- Restart safety verified (flag self-heals within one turn)

### Verification

- 630 tests pass, 0 failures
- typecheck OK (0 errors)
- Deployed to local cache, verified in live session
- KEEP/REF markers tested with real compress calls — all working
