# REQ - Preserve latest user msg when compress range covers all user msgs

- Task ID: `2026-07-20_preserve-last-user-msg`
- Home Repo: `opencode-acp`
- Created: 2026-07-20
- Status: Done
- Priority: P0
- Owner: Sisyphus (awork)
- References: dog/opencode-acp#20 follow-up (after v1.13.1 partial fix)

## 1. Background & Problem Statement

- **Context**:
  - v1.13.1 (PR #167 branch `2026-07-20_compress-notification-fix`) closed one path
    to the zhipuai-lb code 1214 freeze: the chat-style compress notification that
    injected an `ignored: true` user msg which opencode stripped, leaving an empty
    user message.
  - User reported that sessions still freeze after v1.13.1 deployment.
  - Reproduced on `ses_0805cd994ffeeIQYQJHkoGlnLR` (started 13:07 UTC, well after
    v1.13.1 was deployed at 17:46 UTC the prior day).
- **Current behavior (symptom)**:
  - Model emits `compress` with a range that includes the most recent user message.
  - On the very next LLM call, `filterCompressedRanges` removes every user-role
    message because they all fall inside the active block.
  - Provider (zhipuai-lb) rejects the request: `code 1214, "The messages
    parameter is illegal"`, `isRetryable: false`. Session freezes until external
    recovery.
- **Expected behavior**:
  - After `prune`, the message array MUST contain at least one user-role message
    if the input contained any. The most recent user message is the canonical one
    to restore (it carries the active task instruction).
- **Impact**:
  - Hard freeze — non-retryable API error. Model cannot continue without manual
    intervention (new user input or session restart). On the reproducing session,
    OpenCode retried 18 times over 4 minutes before the model self-recovered by
    invoking compress again on the post-prune state.

## 2. Reproduction

- **Environment**:
  - Node: 22.x
  - OS/Arch: linux-x64
  - Plugin: opencode-acp@1.13.1
  - Provider: zhipuai-lb / glm-5.2
- **Minimal reproduction steps**:
  1. Start a session, exchange at least one user/assistant turn.
  2. Model calls `compress` with `startId`/`endId` such that the range covers the
     most recent user message AND no user message exists after the range.
  3. Trigger the next LLM call (model continues tool-calling).
- **Relevant configuration**:
  - Default config (`compress.mode: "range"`, `compress.protectUserMessages: false`).
  - The bug is config-independent as long as pruning is active.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state (`prune.messages.byMessageId`) is
    unchanged — the restore is purely a transform-time decision.
  - Performance: O(n) where n = message count. Two linear passes; acceptable.
  - No synthetic messages injected. Restored message is the original `WithParts`
    reference (byte-identical content, preserves prefix-cache shape).
- **Non-Goals** (explicitly out of scope):
  - Refusing the compress call at the tool layer (model is allowed to compress
    any range; the fix is a transport-level safety net).
  - Restoring more than one user message (only the most recent is needed to
    satisfy API shape).
  - Merging the restored message with the compress summary (would mutate state;
    the restore is view-only).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] If filtering would leave 0 user-role messages, the most recent pruned
        user message is restored at its original position.
  - [x] If at least one user-role message already survives filtering, NO
        restoration happens (no over-restore).
  - [x] If multiple user messages are all pruned, the most RECENT one is chosen.
  - [x] If the input has zero user messages, behavior is unchanged (no crash,
        no spurious restore).
  - [x] Restored user message retains its original `parts` byte-for-byte.
- **Performance / Stability**:
  - [x] All 847 existing tests pass.
  - [x] 5 new regression tests added in `tests/prune.test.ts`.
  - [x] `npm run typecheck` clean.
  - [x] `npm run build` clean.
