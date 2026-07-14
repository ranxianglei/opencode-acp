# REQ - Skip message transform for OpenCode internal agents (title/summary/compaction)

- Task ID: `2026-06-27_title-gen-skip`
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: InProgress
- Priority: P0
- Owner: sisyphus (glm-5.2)
- References: upstream issue ranxianglei/opencode-acp#15 (kratky-pavel report)

## 1. Background & Problem Statement

- **Context**: OpenCode runs built-in internal LLM requests for session title
  generation, conversation summary, and compaction. These are carried by hidden
  primary-mode agents named `title`, `summary`, and `compaction` (confirmed in
  OpenCode source: `packages/core/src/plugin/agent.ts`).
- **Current behavior (symptom)**: When `opencode-acp` is enabled, OpenCode's
  built-in session title generation stops working. New sessions stay named
  "New session - <timestamp>" even after the first user message. Removing ACP
  restores title generation. Reported on ACP 1.3.1 / OpenCode 1.17.11.
- **Expected behavior**: Enabling ACP must not interfere with OpenCode's
  internal title/summary/compaction agent requests.
- **Impact**: Every user sees broken session titles whenever ACP is loaded.
  High-visibility UX regression.

## 2. Root Cause

`createSystemPromptHandler` already skips internal agents via
`INTERNAL_AGENT_SIGNATURES` (checks system prompt text for
"You are a title generator", etc.) and returns early.

`createChatMessageTransformHandler` has **no equivalent guard**. It runs the
full mutation pipeline (checkSession, assignMessageRefs, syncCompressionBlocks,
runMajorGC, prune, injectCompressNudges, injectMessageIds, ...) on every LLM
call — including the small internal title/summary/compaction requests.

This both (a) corrupts the internal request (injects mNNNN tags / nudges into
what should be a pristine prompt) and (b) corrupts shared session state
(`checkSession` runs `countTurns` on the title request's tiny message set,
overwriting `state.currentTurn`; `assignMessageRefs` mutates the ref map from
the wrong message set).

The message transform hook input is typed `{}` (no metadata field exposes the
request type), but the messages themselves carry the signal: the last user
message's `info.agent` field equals `"title"`, `"summary"`, or `"compaction"`
for these internal requests.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: no change to persisted state format, exported APIs,
      or internal `dcp` tags (AGENTS.md §2.6).
    - The fix must not skip legitimate subagent (task) requests — those are
      governed separately by `isSubAgent` + `experimental.allowSubAgents`.
- **Non-Goals** (explicitly out of scope):
    - Refactoring the existing subagent skip logic.
    - Changing the `INTERNAL_AGENT_SIGNATURES` system-prompt detection.
    - Making internal agent names user-configurable (they are OpenCode built-ins).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] `createChatMessageTransformHandler` returns early (no mutation, no state
          change) when the last user message's `agent` is `title`, `summary`, or
          `compaction`.
    - [ ] Normal-agent requests (e.g. `agent: "build"`) are processed exactly as
          before — no behavior change.
    - [ ] `state.currentTurn` / `state.messageIds` are NOT mutated by an internal
          agent request.
- **Performance / Stability**:
    - [ ] No new per-turn overhead on the normal path (single cheap field read).
- **Regression**:
    - [ ] New test cases added to the test suite and passing.
    - [ ] Existing 350 tests still pass.
    - [ ] `npm run build` and `npm run typecheck` pass.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/hooks.ts` — add an internal-agent guard at the top of
      `createChatMessageTransformHandler` (before `checkSession`, to avoid state
      corruption), reusing a shared detector.
    - `tests/e2e-message-transform.test.ts` — add tests covering the skip.
- **Risks**:
    - Low: the detector relies on the `agent` field. If a future OpenCode version
      renames the internal agents, detection would miss. Mitigated by keeping the
      system-prompt-signature detection in the system prompt handler as a second
      layer.
- **Rollback strategy**: revert the single commit; no data migration needed.
