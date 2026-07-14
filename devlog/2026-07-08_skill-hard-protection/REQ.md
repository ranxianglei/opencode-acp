# REQ - Hard-exclude protected tool outputs from compression

- Task ID: `2026-07-08_skill-hard-protection`
- Home Repo: `opencode-acp`
- Created: 2026-07-08
- Status: InProgress
- Priority: P0
- Owner: awork
- References: Gitea issue #16

## 1. Background & Problem Statement

- **Context**: ACP lists `skill` (and `task`, `todowrite`, `todoread`, `decompress`) in
  `COMPRESS_DEFAULT_PROTECTED_TOOLS`. The name implies these tool outputs are protected
  from compression.
- **Current behavior (symptom)**: The protection is only SOFT — `appendProtectedTools`
  appends the verbatim output to the compression summary, but the original message is
  still pruned from visible context. The skill content degrades from a live instruction
  to historical recap, and GC truncation (`maxOldGenSummaryLength` 3000 chars) can
  destroy the appended content entirely.
- **Expected behavior**: Messages containing protected tool outputs (matching
  `compress.protectedTools` or `protectedFilePatterns`) are HARD-excluded from
  compression ranges. They always remain in visible context as-is.
- **Impact**: Loaded skills (and other protected tools) lose their instructional
  authority after compression, and may be silently truncated by GC.

## 2. Reproduction (if applicable)

- **Minimal reproduction steps**:
    1. Load a skill (or call `task`).
    2. Continue the conversation until context grows.
    3. Model calls `compress(m00010, m00030)` where `m00020` is the skill output.
- **Result (before fix)**: `m00020` is removed from visible context; skill text appears
  only as appended content inside the compression summary block.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: no changes to state persistence format, XML tags, or storage
      paths.
    - Do NOT change prompts (user instruction: 方案 a 吧 只做硬性保护 提示词不用改).
    - `appendProtectedTools` stays as a safety net (becomes a no-op for hard-excluded
      messages).
- **Non-Goals**:
    - Prompt text changes (`buildProtectedToolsExtension`, compress prompts).
    - GC `truncateSummary` changes.
    - Any change to state schema.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] Range mode: compressing a range that includes a protected-tool message
          excludes that message from the block; remaining messages compress normally.
    - [ ] Range mode: if ALL messages in all ranges are protected, compress throws a
          clear error.
    - [ ] Message mode: compressing a message that contains a protected tool output is
          skipped with a SoftIssue, reported in the result.
    - [ ] Protected-file-pattern matches also trigger hard exclusion (same as tool-name
          matches).
- **Regression**:
    - [ ] New test cases added and passing.
    - [ ] Existing tests updated for new behavior.

## 5. Proposed Approach

- **Affected modules**:
    - `lib/compress/protected-content.ts` — add `messageContainsProtectedTool` and
      `filterProtectedToolMessages` helpers.
    - `lib/compress/range.ts` — apply filter after `resolveRanges`, before
      `minCompressRange` check; drop empty plans; throw if all empty.
    - `lib/compress/message-utils.ts` — add protected-tool check in `resolveMessage`;
      add `protected-tool` issue template.
- **Risks**: A range that consists entirely of protected tool messages now throws
  instead of compressing. This is expected — the model should not compress skill/task
  outputs.
