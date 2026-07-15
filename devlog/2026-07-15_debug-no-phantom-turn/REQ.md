# REQ - Debug notification triggers phantom model turns

- Task ID: `2026-07-15_debug-no-phantom-turn`
- Home Repo: `opencode-acp`
- Created: 2026-07-15
- Status: Done
- Priority: P0
- Owner: sisyphus
- References: dog/opencode-acp#20, GitHub #93

## 1. Background & Problem Statement

- **Context**: When `config.debug: true`, ACP's message-transform hook fires `debugNotify` on every run to surface the recommendation-filter decision to the user. This callback was wired to `sendIgnoredMessage()` (`lib/ui/notification.ts:299`), which sends a user-role message with `ignored: true` via `client.session.prompt({ body: { noReply: true, ... } })`.
- **Current behavior (symptom)**: opencode does NOT respect `noReply: true` — the `session.prompt()` call triggers a full model turn. The debug notification itself is correctly filtered out of the model's context by `isIgnoredUserMessage()` (`lib/messages/query.ts:43`), so the model sees NO new user input. Its context ends in its own prior assistant output → confusion → hallucination ("user sent a summary of my reply"). This creates a loop: each model response triggers another transform hook → another debug notification → another phantom turn. Observed as agent spamming "待命" (standby) messages indefinitely.
- **Expected behavior**: Debug notifications must NOT trigger model turns. They are diagnostic metadata, not conversation input.
- **Impact**: Infinite phantom-turn loop, wasted tokens, model confusion/hallucination, user-visible spam in chat UI.

## 2. Reproduction

- **Environment**:
  - Node: v25.9.0
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1. Set `debug: true` in `~/.config/opencode/acp.jsonc`
  2. Have a session with compressible ranges (enough context for the recommendation filter to produce output)
  3. Observe: every LLM call triggers a debug notification → phantom turn → model responds → triggers another debug notification → loop
- **Relevant configuration**: `debug: true`

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `sendIgnoredMessage()` stays (used by other notification paths); only the `debugNotify` wiring changes.
  - `noReply: true` not being respected is an opencode-core behavior the plugin cannot fix.
- **Non-Goals**: Fixing opencode's `noReply` handling; removing `sendIgnoredMessage` entirely.

## 4. Acceptance Criteria

- **Correctness**:
  - [x] `debugNotify` no longer calls `session.prompt()` — uses `logger.debug()` (pure file log, zero model turns)
  - [x] Debug info still recorded in `logs/acp/daily/` log file for diagnostics
- **Performance / Stability**:
  - [x] No phantom turns triggered by debug notifications
  - [x] No infinite "待命" loop
- **Regression**:
  - [x] Full test suite passing (713/713)

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/hooks.ts:282-292` — `debugNotify` callback: `sendIgnoredMessage` → `logger.debug`
  - `lib/hooks.ts:45` — removed unused `sendIgnoredMessage` import
- **Risks**: Low. Debug filter decisions no longer visible in chat UI (only in log file). Acceptable tradeoff — debug mode is for diagnostics.
- **Rollback strategy**: Revert single commit.
