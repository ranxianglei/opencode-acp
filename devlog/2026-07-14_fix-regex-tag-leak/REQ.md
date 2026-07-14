# REQ: Fix stripHallucinations regex tag fragment leak (issue #123)

## Problem Statement

Issue #123: After multiple compression rounds, ACP internal XML tag fragments (like `</d-message-id>`) and stale message IDs (`m00097`) leak into user-visible chat. PR #124 by mengfanbo123 identified the root cause in `DCP_PAIRED_TAG_REGEX` (line 14) but the fix was incomplete — two more regexes on lines 11 and 13 have the same class of bug.

## Root Cause

Three regexes in `lib/messages/utils.ts` were broken:

### Line 14: `DCP_PAIRED_TAG_REGEX` (fixed by PR #124)
- **Before**: `/]*>[\s\S]*?<\/(?:dcp|acp)[^>]*>/gi` — `]*>` matches literal `]` zero+ times then `>`, matching ANY `>` character instead of `<dcp...>` opening tags
- **After**: `/<(?:dcp|acp)[^>]*>[\s\S]*?<\/(?:dcp|acp)[^>]*>/gi` — correctly matches opening tags
- **Impact**: `stripHallucinationsFromString` partially deleted paired tags (removed closing tag + content, left opening tag fragments)

### Line 11: `DCP_BLOCK_ID_TAG_REGEX` (NOT fixed by PR #124)
- **Before**: `/(])[^>]*>)b\d+(<\/(?:dcp|acp)-message-id>)/g` — `(])` requires literal `]` character, so it NEVER matches real message-id tags
- **After**: `/(<(?:dcp|acp)-message-id[^>]*>)b\d+(<\/(?:dcp|acp)-message-id>)/g` — correctly matches opening tag
- **Impact**: `replaceBlockIdsWithBlocked` never worked — block IDs inside message-id tags were never replaced with "BLOCKED"

### Line 13: `DCP_MESSAGE_REF_TAG_REGEX` (NOT fixed by PR #124)
- **Before**: `/m\d+<\/(?:dcp|acp)-message-id>/g` — matches `m00097</dcp-message-id>` but leaves `<dcp-message-id ...>` opening tag fragment behind
- **After**: `/<(?:dcp|acp)-message-id[^>]*>m\d+<\/(?:dcp|acp)-message-id>/g` — matches the full tag, no fragments
- **Impact**: `stripStaleMessageRefs` left opening tag fragments in compression summaries

## Acceptance Criteria

- [x] All three regexes fixed in `lib/messages/utils.ts`
- [x] Comprehensive tests covering all three functions (`tests/regex-tag-leak.test.ts`, 23 tests)
- [x] TypeScript: pass
- [x] Full test suite: 666 pass, 0 fail
- [x] Supersedes PR #124 (which only fixed line 14)

## Constraints

- Backward compatible — no persisted state format changes
- Supersedes PR #124 — includes and extends its fix
- Test review required (AGENTS.md Section 5.6)
