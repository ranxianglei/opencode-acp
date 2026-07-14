# WORKLOG: Fix stripHallucinations regex tag fragment leak

## Commits

| Commit | Description |
|--------|-------------|
| `2026-07-14` | fix: correct all 3 broken regexes in lib/messages/utils.ts (issue #123) |

## Changes

### `lib/messages/utils.ts` (3 regex fixes)

| Line | Regex | Bug | Fix |
|------|-------|-----|-----|
| 11 | `DCP_BLOCK_ID_TAG_REGEX` | `(])` requires literal `]`, never matches real tags | `(<(?:dcp\|acp)-message-id[^>]*>)` correctly captures opening tag |
| 13 | `DCP_MESSAGE_REF_TAG_REGEX` | Missing opening tag match, leaves fragment | Added `<(?:dcp\|acp)-message-id[^>]*>` prefix |
| 14 | `DCP_PAIRED_TAG_REGEX` | `]*>` matches any `>`, not opening tags (PR #124 fix) | `<(?:dcp\|acp)[^>]*>` correctly matches opening tags |

### `tests/regex-tag-leak.test.ts` (NEW, 23 tests)

- `replaceBlockIdsWithBlocked`: 7 tests (attributes, bare, multiple, message-ref safety, surrounding text, large IDs)
- `stripStaleMessageRefs`: 8 tests (attributes, bare, multiple, no-fragment regression, surrounding text, block-ID safety)
- `stripHallucinationsFromString`: 8 tests (paired dcp/acp, issue #123 core case, attributes, nested, multiple, orphan, non-dcp safety, multi-round regression)

## Key Decisions

- **Supersede PR #124 rather than amend**: PR #124 only fixed line 14. Lines 11 and 13 have the same class of bug. Creating a new PR with all three fixes is cleaner than requesting changes on the contributor's fork.
- **Nested tag behavior**: Non-greedy matching (`*?`) means innermost pairs are matched first. This is pre-existing behavior, not a regression. Test documents this explicitly.

## Test Results
- TypeScript: pass
- Tests: 666 pass, 0 fail (643 existing + 23 new)
- CI check (`check-pr.sh`): All checks passed

## Relationship to PR #124
- PR #124 (mengfanbo123): Fixed only line 14 (`DCP_PAIRED_TAG_REGEX`). Correct fix but incomplete.
- This PR: Fixes all three regexes (lines 11, 13, 14). Supersedes PR #124.
