# WORKLOG: Preserve Recent Messages from Compression

## Changes

### 1. Config (`lib/config.ts`)
- Added 3 optional fields to `CompressConfig`: `preserveRecentMessages`, `preserveRecentTokens`, `preserveLastUserMessage`
- Added defaults to `DEFAULT_CONFIG.compress`: 20 / 20000 / true

### 2. Pipeline (`lib/compress/pipeline.ts`)
- Replaced `checkLastSegmentDangerous` with `checkProtectedRange`
- Added `computeProtectedRawIds` — computes protected message IDs from 3 rules (message count, token count, last user message)
- Fixed `preserveN=0` bug: `slice(-0)` returns all elements in JavaScript; added `if (preserveN > 0)` guard
- Error message now shows actual config values instead of hardcoded "20"

### 3. Inject Utils (`lib/messages/inject/utils.ts`)
- Added `computeProtectedRefs` — same 3-rule computation but returns refs (mNNNNN) for recommendation filtering
- Added `excludeProtectedRanges` — filters ranges whose startRef is in the protected set
- Fixed same `preserveN=0` bug

### 4. Inject (`lib/messages/inject/inject.ts`)
- Imported `computeProtectedRefs` and `excludeProtectedRanges`
- Applied protection filtering BEFORE `filterRecommendedRanges` — protected ranges never appear in recommendations
- Nudge suppression is automatic: if all ranges are filtered → `nothingToCompress` → nudge suppressed

### 5. Callers Updated
- `lib/compress/range.ts`: `checkLastSegmentDangerous` → `checkProtectedRange`
- `lib/compress/message.ts`: same

### 6. Tests

**`tests/soft-block.test.ts`** (rewritten, 8 tests):
1. Compressing recent messages fails without `dangerous`
2. Compressing recent messages with `dangerous: true` succeeds
3. Compressing old messages (outside 20-msg window) succeeds
4. `lastSegmentSoftBlock: false` disables protection
5. Error message mentions protected message IDs
6. Last user message always protected (even outside message-count window)
7. Custom `preserveRecentMessages: 5` only protects last 5
8. `preserveRecentMessages: 0` + `preserveRecentTokens: 0` disables all protection

**`tests/preserve-recent.test.ts`** (new, 7 tests):
1. Default config protects last 40 msgs (token rule broader than count)
2. Last user message always protected with count=1
3. Token-only protection (count=0)
4. All disabled returns empty set
5. `excludeProtectedRanges` removes ranges starting in protected zone
6. Empty protected set returns all ranges
7. Nudge suppressed when all compressible ranges are in protected zone

**Existing tests updated:**
- `tests/inject.test.ts`: Added `preserveRecentMessages: 0, preserveRecentTokens: 0, preserveLastUserMessage: false` to `buildConfig()` — disables protection for nudge growth tests
- `tests/e2e-blocks-nudges.test.ts`: Same config fields added

## Verification

- typecheck: PASS
- 861 tests pass, 0 fail
- Build: PASS
