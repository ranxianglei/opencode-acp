# REQ: Compression Recap Injection Fix + Stale Compress Stripping + Baseline + KEEP/REF + Notification

## Problem

Issue #23 uncovered multiple bugs during testing:

1. **CRITICAL: Compression summaries not properly injected as tool results**
    - `acp_context_recap` was used to create synthetic tool-result recap messages (`createSyntheticToolRecap`) but was NOT registered as a real tool in `index.ts`
    - Provider may strip/convert unregistered tool-results → model sees content as plain text or user messages → treats as instructions (echo/drift bugs)

2. **Compress tool call input/output duplication**
    - After compression, the original `compress` tool call (with full summary text as input) remains in previous turns
    - Model sees BOTH the compress call input AND the block recap → duplicated content consuming context

3. **Baseline leak after compress**
    - Compress drops context to X → model continues working to Y same turn → baseline re-establishes to Y → (Y-X) headroom leaked
    - Voluntary compress (no nudge) also reset baseline, leaking accumulated growth

4. **KEEP/REF regex mismatch**
    - Regex `m\d+` captures unpadded `m150` but ref map uses 5-digit `m00150` → silent lookup failure → markers left as literal text

5. **KEEP/REF not called in message mode**
    - `resolveKeepMarkers` only called in `range.ts`, not `message.ts` → markers ignored in message-mode compression

6. **Toast notification replace() fails**
    - `buildCompressionSummary` returns uncapped summary for single entry, but toast path searches for truncated version → `replace()` silently fails

7. **Notification range display**
    - Notifications show block ID but not WHICH message range was compressed

8. **Stale TODOs**
    - `message.ts` and `range.ts` had TODOs about compress input cleanup being unimplemented — now implemented via `stripStaleCompressCalls`

## Solution

### 1. Register `acp_context_recap` as real tool (`lib/compress/recap.ts`)

- Execute returns block summary for given `blockId`
- Provider now properly serializes synthetic tool-result recap messages
- Model sees `role: "tool"` (neutral data), not user/assistant content

### 2. `stripStaleCompressCalls` (`lib/messages/prune.ts`)

- Removes `compress` tool-call parts from messages BEFORE the last real user message (previous turns)
- Current-turn compress calls preserved
- Non-compress parts in same message preserved
- All-compress messages removed entirely
- Called from `hooks.ts` after `prune()`, before `assignMessageRefs()`

### 3. Proportional baseline adjustment (`lib/messages/inject/inject.ts`)

- Pre-prune token count captured in `hooks.ts`, passed to `injectCompressNudges`
- After compress: `adjustment = min(1, compressed/growth * 2)` → proportional baseline update
- Voluntary compress (no nudge) → baseline unchanged
- `compressBaselineSet` lock prevents inflation from same-turn continuation work

### 4. KEEP/REF regex normalization (`lib/compress/keep-markers.ts`)

- `normalizeRef()` uses `parseMessageRef` + `formatMessageRef` to pad refs before lookup

### 5. `resolveKeepMarkers` in message mode (`lib/compress/message.ts`)

### 6. Toast fix (`lib/ui/notification.ts`)

- `displaySummary` hoisted to function scope, used as replace target
- Detailed mode: no truncation; Minimal mode: 1500-char limit

### 7. Notification range display (`lib/ui/notification.ts`)

- `formatEntryRanges()` uses `block.startId`/`endId` directly (already refs)
- Shows `→ Range: b20: m00150–m00155`

### 8. Reverted `postCompressRangesShown`

- Initially added to show remaining ranges after compress — caused over-compression chains
- Removed entirely; model uses `acp_status` on-demand instead

## Files

- `lib/compress/recap.ts` (NEW) — `acp_context_recap` tool
- `index.ts` — register recap tool
- `lib/compress/index.ts` — barrel export
- `lib/compress/keep-markers.ts` — normalizeRef
- `lib/compress/message.ts` — resolveKeepMarkers + stale TODO fix
- `lib/compress/range.ts` — stale TODO fix
- `lib/hooks.ts` — stripStaleCompressCalls in pipeline + prePruneTokens capture
- `lib/messages/index.ts` — barrel export
- `lib/messages/inject/inject.ts` — proportional baseline + compressBaselineSet lock
- `lib/messages/prune.ts` — stripStaleCompressCalls
- `lib/ui/notification.ts` — toast fix + formatEntryRanges + detailed mode no truncation
- `tests/strip-stale-compress.test.ts` (NEW) — 7 tests
- `tests/inject.test.ts` — baseline tests updated
- `tests/e2e-blocks-nudges.test.ts` — updated

## Oracle Review

Session: `ses_0a9e7225fffeLEUmfoSEBSs7vG`

- **0 CRITICAL issues** — all fixes correct, safe to merge
- **2 WARN items addressed**: W1 (test coverage) + W2 (stale TODOs)
- All edge cases verified
