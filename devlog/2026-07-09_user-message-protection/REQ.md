# REQ - Important User Message Protection

- Task ID: `2026-07-09_user-message-protection`
- Home Repo: `opencode-acp`
- Created: 2026-07-09
- Status: InProgress
- Priority: P1
- Owner: awork
- References: issue #16

## 1. Background & Problem Statement

- **Context**: v1.10.0 shipped hard-exclusion of protected tool outputs (skill/task/todowrite). However, user messages containing important instructions, constraints, or error corrections can still be compressed into summaries, where they degrade across multiple compression cycles ("似是而非" problem).
- **Current behavior**: `compress.protectUserMessages: false` is all-or-nothing. When off, all user messages are compressible. When on, ALL user messages are soft-protected (appended to summaries) — too broad.
- **Expected behavior**: Automatically detect user messages containing importance markers (zh+en) via regex. Hard-exclude these from compression ranges (same pattern as protected tool messages). Exclude obvious data-input (logs, code, JSON) even if they contain keywords.
- **Impact**: Prevents critical instructions/constraints from being lost during compression.

## 2. Constraints & Non-Goals

- **Constraints**:
    - No new dependencies (pure regex, no vector embedding in v1)
    - Backward compatible: feature off by default
    - Follow existing `filterProtectedToolMessages` pattern exactly
    - No prompt changes (user explicitly said "提示词不用改")
- **Non-Goals**:
    - Vector embedding-based detection (future iteration)
    - Model-driven pinning tool (future iteration)
    - System prompt injection of pinned content (future iteration)

## 3. Acceptance Criteria

- **Correctness**:
    - [ ] User message with importance marker (zh) → hard-excluded from compression
    - [ ] User message with importance marker (en) → hard-excluded from compression
    - [ ] User message with log/code/JSON data → NOT protected even if contains keyword
    - [ ] Feature disabled by default → no behavior change
    - [ ] Works in both range mode and message mode
- **Regression**:
    - [ ] New test cases added and passing
    - [ ] Existing 591 tests still pass

## 4. Proposed Approach

- **Affected modules**:
    - `lib/messages/importance-detector.ts` (NEW — regex classifier + data-input gate)
    - `lib/compress/protected-content.ts` (add `filterImportantUserMessages`)
    - `lib/compress/range.ts` (apply filter after `filterProtectedToolMessages`)
    - `lib/compress/message.ts` (apply filter in message mode)
    - `lib/config.ts` (add `compress.protectImportantUserMessages: false`)
