# Learnings: remove-gc-compress-anchor

## Task: Remove dead `gc` config blocks from test files

### What was done

- Removed `gc: { ... }` property blocks from 15 test config objects
- 13 multi-line blocks (8 lines each) + 2 single-line blocks (pipeline.test.ts, inject.test.ts)
- No `GCConfig` imports existed in any test file (already cleaned)
- `compress-rollback.test.ts` was already fixed before this task

### Files edited (15)

- tests/strategies-purge-errors.test.ts
- tests/compress-message.test.ts
- tests/strategies-dedup.test.ts
- tests/compress-range.test.ts
- tests/nudge-text.test.ts (only file with `lowThreshold: "55%"`, rest use "60%")
- tests/e2e-message-transform.test.ts
- tests/e2e-blocks-nudges.test.ts
- tests/query-mock.test.ts
- tests/keep-markers.test.ts
- tests/pipeline.test.ts (single-line gc block)
- tests/hooks-permission.test.ts
- tests/protected-tool-exclusion.test.ts
- tests/inject.test.ts (single-line gc block)
- tests/rebuild.test.ts
- tests/prune.test.ts

### Edit pattern that worked

Every multi-line gc block was preceded by `        },` (closing of previous config section).
Used that line as anchor context in oldString + newString to avoid trailing-newline ambiguity.

### Verification

- `npm run typecheck`: 0 errors ✓
- `npm test`: 643 tests, 628 pass, 15 fail
- The 15 failures are PRE-EXISTING (caused by lib gc removal in prior branch commits, NOT by test gc block removal). Confirmed by stashing only my 15 test edits: pre-edit state has 644 tests / 629 pass / 15 fail. The 1-test difference ("block aging: old blocks are deactivated by major GC") was a PRE-EXISTING removal in e2e-blocks-nudges.test.ts working tree, not caused by my edits.
- Task brief said "same pass count (650)" — actual comparable baseline is 629 pass (the branch already has 15 pre-existing failures from the lib gc removal that are out of scope for this test-cleanup task).
