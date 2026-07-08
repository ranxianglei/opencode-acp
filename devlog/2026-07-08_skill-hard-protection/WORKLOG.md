# WORKLOG - Hard-exclude protected tool outputs from compression

- Task ID: `2026-07-08_skill-hard-protection`
- Created: 2026-07-08
- Status: Done

## Timeline

### 2026-07-08 — Investigation + Implementation

**Investigation:**
- Analyzed compress pipeline: `resolveRanges` → `applyCompressionState` → `appendProtectedTools`.
- Found that `appendProtectedTools` provides only SOFT protection (appends verbatim output
  to summary), while `applyCompressionState` still prunes the original message from visible
  context.
- Found GC truncation risk: `runTruncateGC` truncates old-gen summaries to 3000 chars,
  destroying appended skill content.
- Posted root cause analysis to Gitea issue #16. User chose 方案 A (hard exclusion only,
  no prompt changes).

**Implementation (3 files modified, 1 file added):**

1. `lib/compress/protected-content.ts`:
   - Added `messageContainsProtectedTool(message, protectedTools, protectedFilePatterns)`: checks
     if any part is a tool call with a protected tool name or protected file path.
   - Added `filterProtectedToolMessages(selection, searchContext, protectedTools, protectedFilePatterns)`:
     removes protected-tool messages from `selection.messageIds`, `messageTokenById`, and
     `toolIds`. Returns original selection if nothing to filter.
   - Added `WithParts` import from `../state`.

2. `lib/compress/range.ts`:
   - After `resolveRanges` + `validateNonOverlapping`, applies `filterProtectedToolMessages`
     to each plan's selection.
   - Drops plans whose filtered `messageIds` is empty.
   - Throws clear error if ALL plans are empty after filtering.
   - Downstream loops use `filteredPlans` instead of `resolvedPlans`.

3. `lib/compress/message-utils.ts`:
   - Added `messageContainsProtectedTool` import.
   - Added `"protected-tool"` entry to `ISSUE_TEMPLATES`.
   - In `resolveMessage`, after `isProtectedUserMessage` check, throws `SoftIssue("protected-tool")`
     if the message contains a protected tool output.

4. `tests/protected-tool-exclusion.test.ts` (NEW):
   - 12 tests covering: `messageContainsProtectedTool` (4 tests), `filterProtectedToolMessages`
     (2 tests), range mode exclusion (4 tests), message mode exclusion (2 tests).
   - Tests verify: skill/task exclusion from range, middle-of-range exclusion, all-protected
     error, message mode skip + issue reporting, custom protectedTools config (empty = no
     exclusion), protected file patterns.

**Existing test fixes (tests/compress-message.test.ts):**
- Updated 4 tests that assumed protected tool outputs would be compressed + appended to
  summary. With hard exclusion, those messages are now skipped.

**Verification:**
- `npm run typecheck` — PASS (0 errors)
- `npm run build` — PASS (tsup + tsc --emitDeclarationOnly)
- Relevant tests: 233 pass, 0 fail across 11 test files.
  (39 pre-existing bun runner limitations in nested-test files remain, unrelated to this change.)

## Design Decisions

1. **Why filter after resolveRanges, not inside resolveSelection?**
   - `resolveSelection` is a generic utility that doesn't have access to config.protectedTools.
   - Filtering at the pipeline level keeps the concern separated and testable.

2. **Why keep `appendProtectedTools` as-is?**
   - It becomes a no-op for hard-excluded messages (they're no longer in selection.messageIds).
   - It serves as a safety net for any edge case where a protected tool message slips through.
   - User instruction: minimal changes, only hard protection.

3. **Why throw when ALL messages are protected?**
   - The model needs feedback that its compress range is invalid.
   - The error message is clear: "All selected messages contain protected tool outputs".
   - Alternative (returning "Compressed 0 messages") would be confusing.
