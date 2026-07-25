# REQ - Remove subagent history rewriting

- Task ID: `2026-07-22_remove-subagent-history-rewrite`
- Home Repo: `opencode-acp`
- Created: 2026-07-22
- Status: Done
- Priority: P0
- Owner: Sisyphus (bot)
- References: Gitea `dog/opencode-acp#20`, Gitea `dog/opencode-acp#176`

## 1. Background & Problem Statement

- **Context**: ACP has an `experimental.allowSubAgents` flag that bundles two
  conceptually separate behaviors:
  1. (PRIMARY) Lets ACP run inside subagent sessions (system prompt + compress
     tool registration).
  2. (SECONDARY) Rewrites the parent agent's historical `<task_result>` blocks
     in-place via `injectExtendedSubAgentResults`, expanding the placeholder
     output of a completed `task` tool call with the subagent's full result.

- **Current behavior (symptom)**: With `allowSubAgents: true`, every parent
  message-transform run that touches a prior `task` tool call re-fetches the
  subagent session and rewrites the historical message body. Because
  `subAgentResultCache` is wiped on every session switch (parent ↔ child via
  `resetSessionState`) and is never persisted, the rewrite fires repeatedly
  across turns. Each rewrite mutates historical message content, which breaks
  the provider's prefix cache at the rewrite point — observed cache hit rate
  dropped to ~56% (healthy sessions are 96–98%), with the prefix frozen at
  ~22,016 tokens.

- **Expected behavior**: Removing the history-rewriting behavior should let
  the provider prefix cache stay stable across turns. The primary behavior
  (ACP running inside subagent sessions) is unaffected and remains gated by
  the same flag.

- **Impact**: Users of `experimental.allowSubAgents: true` pay a large cache
  cost for no functional benefit, because OpenCode natively appends a
  `state="completed"` message with the full subagent result immediately after
  the `task` call completes. The rewrite is redundant.

## 2. Reproduction

- **Environment**: Any opencode session using ACP with
  `experimental.allowSubAgents: true` that has invoked the `task` tool.
- **Minimal reproduction steps**:
  1. Enable `experimental.allowSubAgents: true`.
  2. Trigger a `task` subagent call in a long session.
  3. Observe provider cache metrics across subsequent turns — prefix cache
     stalls at the message that contains the rewritten `<task_result>`.
- **Relevant configuration**:
  ```jsonc
  { "experimental": { "allowSubAgents": true } }
  ```

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `experimental.allowSubAgents` must still enable
    ACP inside subagent sessions.
  - No new dependencies.
  - AGENTS.md forbids `as any`, `@ts-ignore`.
- **Non-Goals**:
  - Changing the primary behavior of `allowSubAgents` (subagent-session
    compression).
  - Adding persistence for `subAgentResultCache` (cache is being removed,
    not fixed).
  - Any change to OpenCode's native `task` tool result handling.

## 4. Acceptance Criteria

- **Correctness**:
  - [x] `injectExtendedSubAgentResults` is removed from the message-transform
        pipeline and its source file deleted.
  - [x] `appendProtectedTools` no longer expands subagent results into
        compression summaries; signature drops the `allowSubAgents` param.
  - [x] `subAgentResultCache` removed from `SessionState` type and factory.
  - [x] `lib/subagents/subagent-results.ts` deleted (dead code after above).
  - [x] `lib/messages/inject/subagent-results.ts` deleted.
  - [x] `lib/messages/index.ts` no longer re-exports the deleted symbol.
  - [x] All 10 affected test files updated to drop the cache field from
        mock state factories.
- **Performance / Stability**:
  - [x] Historical messages are no longer mutated mid-session → provider
        prefix cache should remain stable for users of `allowSubAgents`.
- **Regression**:
  - [x] `npm run typecheck` clean.
  - [x] `npm run test` — 835/835 pass.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/hooks.ts` — drop `injectExtendedSubAgentResults` call + import.
  - `lib/compress/protected-content.ts` — drop subagent expansion branch
    and `allowSubAgents` parameter from `appendProtectedTools`.
  - `lib/compress/range.ts`, `lib/compress/message.ts` — update call sites.
  - `lib/messages/inject/subagent-results.ts` — delete.
  - `lib/subagents/subagent-results.ts` — delete (dir removed).
  - `lib/messages/index.ts` — drop re-export.
  - `lib/state/types.ts`, `lib/state/state.ts` — drop `subAgentResultCache`.
  - 10 test files — drop cache field from mocks.
  - `tests/e2e-message-transform.test.ts` — update pipeline comment.
- **Risks**: Low. Removed code path was the sole source of the cache bug;
  no other behavior depends on it.
- **Rollback strategy**: `git revert` the commit.
