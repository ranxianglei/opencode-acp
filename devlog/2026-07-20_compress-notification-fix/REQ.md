# REQ - Compress notification triggers API 400 on strict providers

- Task ID: `2026-07-20_compress-notification-fix`
- Home Repo: `opencode-acp`
- Created: 2026-07-20
- Status: InProgress
- Priority: P0
- Owner: sisyphus
- References: dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: ACP's compress-notification path (`lib/ui/notification.ts:296`) calls `sendIgnoredMessage()` after every successful compression. `sendIgnoredMessage()` injects a user-role message via `client.session.prompt({ body: { noReply: true, parts: [{ type: "text", text: ..., ignored: true }] }})`. opencode correctly strips `ignored: true` parts from the LLM input, leaving the user message with **zero content parts**.
- **Current behavior (symptom)**: When the post-compress continuation LLM call hits the empty user message, strict providers (zhipuai GLM, possibly others) return HTTP 400 with code 1214 "messages 参数非法" / "messages parameter is illegal". `isRetryable: false`. opencode does not retry. The assistant's turn appears "stuck" until the next external input (e.g. awork-web SYSTEM NUDGE).
- **Expected behavior**: Compression must not produce a malformed `messages` array. The post-compress continuation call must succeed (or fail for unrelated reasons).
- **Impact**: 113 occurrences across all sessions on this machine. User reports "停住" (pause) happening "非常多次了，一直没找到根本原因". Every occurrence blocks the session for 30s–3min until external recovery.

## 2. Reproduction

- **Environment**:
  - Node: v25.x
  - OS/Arch: linux-x64
  - Provider: `zhipuai-lb` (load-balancer fronting GLM-5.2)
  - ACP config: `pruneNotificationType: "chat"` (default), `pruneNotification: "detailed"` (default)
- **Minimal reproduction steps**:
  1. Use a strict LLM provider (zhipuai GLM via any front-end)
  2. Have a session large enough to trigger compression
  3. Model calls `compress` tool
  4. ACP processes compression, calls `sendIgnoredMessage` → creates user msg with `ignored: true` part
  5. opencode initiates continuation LLM call (model continues after compress)
  6. opencode serializes messages, strips `ignored: true` → user message is empty
  7. zhipuai API returns 400 code 1214, `isRetryable: false`
  8. opencode gives up, session appears stuck
- **Relevant configuration**: `pruneNotificationType: "chat"` (the default)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `sendIgnoredMessage()` stays — slash-command paths (`/acp context`, `/acp stats`, etc.) still use it safely because they're user-initiated and don't trigger an LLM continuation.
  - The `pruneNotificationType` config key stays (deprecation warning only) — users have it in their `acp.jsonc`.
  - No new dependencies.
- **Non-Goals**:
  - Removing `sendIgnoredMessage` entirely (slash commands still need it).
  - Fixing opencode's stripping of `ignored: true` parts (that's an opencode-core behavior, correct in principle).
  - Adding rich UI rendering for the compress tool result (deferred — user said "UI can render however later").

## 4. Acceptance Criteria

- **Correctness**:
  - [ ] `sendCompressNotification` never calls `sendIgnoredMessage` — only `client.tui.showToast()`
  - [ ] Compress tool output is a single-line header (no rich progress bar / summary preview in tool result)
  - [ ] `dropEmptyMessages` also drops messages where all parts have `ignored: true` (defensive)
  - [ ] No regression: existing slash-command paths (`/acp stats`, etc.) still work unchanged
- **Performance / Stability**:
  - [ ] Post-compress continuation LLM call no longer sees empty user message
  - [ ] No new DB writes from compression path (was 1 user msg per compress, now 0)
- **Regression**:
  - [ ] New test case in `tests/drop-empty-messages.test.ts` for ignored-only messages
  - [ ] Updated assertions in `tests/compress-range.test.ts` / `tests/compress-message.test.ts` if needed
  - [ ] All 842+ existing tests still pass

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/ui/notification.ts` — remove `sendIgnoredMessage` path from `sendCompressNotification`; only `showToast` remains
  - `lib/compress/range.ts` — simplify compress tool output to single-line header
  - `lib/compress/message.ts` — same, for message-mode
  - `lib/messages/utils.ts` — extend `dropEmptyMessages` to treat `ignored: true` parts as empty
- **Risks**:
  - Users who relied on chat-side compression history will see less detail (only the compress tool call's `input` carries the summary now; toast is transient). Mitigated: compress tool input has all the same info, and `acp-inspect --blocks` reads full history.
  - `pruneNotificationType: "chat"` config value becomes a no-op. Mitigated: deprecation warning in logs.
- **Rollback strategy**: Revert the PR. The bug it fixes is severe enough (session-stalling) that users will notice immediately if the fix regresses.
