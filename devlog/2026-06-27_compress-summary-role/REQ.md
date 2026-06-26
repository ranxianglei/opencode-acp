# REQ: Fix compression summary causing dialog role confusion (Bug 36)

- Task ID: `2026-06-27_compress-summary-role`
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: InProgress
- Priority: P1
- Owner: awork (glm-5.2)
- References: upstream issue https://github.com/ranxianglei/opencode-acp/issues/14 ; dog/opencode-acp#1

## 1. Background & Problem Statement

- **Context**: ACP replaces compressed conversation ranges with a synthetic summary message on every message-transform pass (`lib/messages/prune.ts` → `filterCompressedRanges`).
- **Current behavior (symptom)**: The summary is **always** created with `role: "user"` (`createSyntheticUserMessage`, hardcodes `role: "user"`). It is injected at the start of the pruned range. When the first surviving message after the range is also a user turn, the output becomes `[summary(user), user(user), assistant]` — two consecutive user-role messages. The model then reads its own prior assistant output (now inside the user-role summary) as user input, causing **self-Q&A loops** and dialog role confusion. Most noticeable in structured skill flows (e.g. `grill`).
- **Expected behavior**: After compression, the model must never perceive its own prior assistant output as a fresh user turn. No two consecutive user-role historical messages should result from a compression pass.
- **Impact**: Conversational derailment in long sessions and skill flows; the plugin's core value proposition is stability.

## 2. Reproduction

- **Minimal reproduction**: A conversation `[u1, a1, u2, a2]` with an active compression block covering `u1,a1` produces `[SUMMARY(user), u2(user), a2(assistant)]`. The model sees two user turns and may respond to its own recapped output.
- **Relevant configuration**: any; default `compress.mode: "range"` or `"message"` both affected.

## 3. Constraints & Non-Goals

- **Constraints**:
  - The OpenCode SDK only supports `role: "user"` and `role: "assistant"` for messages (no mid-conversation `system`). The `AssistantMessage` type additionally requires `parentID, modelID, providerID, mode, path, cost, tokens` — fabricating these is high-risk for a stability plugin and is **out of scope**.
  - The synthetic message id prefix `msg_dcp_summary_` is load-bearing (`isSyntheticMessage`, `assignMessageRefs` skip, state cleanup) and must remain stable/deterministic for prompt-cache stability.
  - Transform is transient (rebuilt from raw state each LLM call); prune.ts already mutates message text/tool-outputs in-place per pass.
- **Non-Goals**:
  - Not changing the compression block data model, GC, decompress/recompress, or the suffix-guidance nudge message (which legitimately must remain `role: "user"`).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] After compression, no two adjacent historical (non-suffix-nudge) messages both have `role: "user"`.
  - [x] The recap content is preserved and visible to the model (merged into the following user message, or a separate user message only when no following user turn exists).
  - [x] The following user message's original text is preserved after the recap is prepended.
- **Regression**:
  - [x] Updated `tests/e2e-message-transform.test.ts` compression-blocks test to reflect merge behavior.
  - [x] Added dedicated regression test "compression summary: never produces two consecutive user turns (Bug 36)".
  - [x] `npm run typecheck` clean; full test suite green (only the pre-existing bun-runner nested-test limitation in `prompts.test.ts` remains, unrelated).

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/utils.ts` — add `prependCompressionSummary()` helper (idempotent prepend into a message's first text part, block-scoped delimiter).
  - `lib/messages/prune.ts` — `filterCompressedRanges`: when the next surviving message is a user turn, merge the summary into it instead of emitting a standalone synthetic user message; otherwise retain prior behavior (standalone user message / fallback).
- **Risks**: Multiple adjacent blocks sharing the same following user message → multiple recap prefixes (acceptable; each is block-delimited and idempotent per block).
- **Rollback strategy**: Revert the two-file change; behavior returns to standalone user-role summary messages.
