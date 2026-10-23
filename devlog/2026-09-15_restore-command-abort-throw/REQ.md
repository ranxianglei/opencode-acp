# REQ - Restore command-abort throw for /acp subcommands (fix #398)

- Task ID: `2026-09-15_restore-command-abort-throw`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: InProgress
- Priority: P1
- Owner: ranxianglei (ework-daemon agent)
- References: https://github.com/ranxianglei/opencode-acp/issues/398, regression commit `5fd8f5ee9` (PR #297, fixing #296)

## 1. Background & Problem Statement

- **Context**: The `/acp` command is registered in the config hook with `template: ""` (no `$ARGUMENTS`
  placeholder). opencode's `Plugin.trigger` aborts a command ONLY when the
  `command.execute.before` hook throws; a normal return lets opencode proceed to render the
  template and send it as a user message. Since the template is empty, the raw arguments are
  appended verbatim into the message body (`packages/opencode/src/session/prompt.ts:1390-1393`).
- **Current behavior (symptom)**: On v1.17.0+ (master `70beea0`, v1.18.0), running `/acp status`,
  `/acp stats`, or `/acp context` shows the `[ACP Status]` output AND leaks the subcommand word
  (e.g. `status`) as a plain user message to the model, which then answers it (spurious model
  call, token burn, session pollution). Bare `/acp` does not leak (empty args → empty prompt).
  `/acp help` and `/acp export` do not leak (those branches still throw).
- **Expected behavior**: All `/acp` subcommands are fully handled inside the hook and the command
  is aborted — no message is ever sent to the model (≤v1.16.0 semantics).
- **Impact**: Every `/acp status|stats|context` invocation triggers an unintended full model call
  (~40K input tokens in the reporter's A/B test) and confuses the conversation. Regression since
  v1.17.0.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1) opencode ≥1.16 + opencode-acp ≥1.17.0, default config
  2) Type `/acp status` in a session
  3) Observe: `[ACP Status]` block appears, then a user message with text `status` triggers a model call
- **Relevant configuration**: none special; `config.commands.enabled: true` (default)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: restoring the throw returns exactly ≤v1.16.0 semantics; no state
    format, API, or tag changes.
  - Known cost (accepted): on opencode ≥1.18.18 each `/acp` invocation logs one `level=ERROR`
    line for the thrown `__DCP_CONTEXT_HANDLED__` error — this is the original complaint of
    #296 and is the documented trade-off of the only available abort mechanism. Log noise ≪
    spurious model invocation.
  - Performance requirements: none (command path only).
- **Non-Goals** (explicitly out of scope):
  - Negotiating a silent-abort API with opencode upstream (hook returning a cancel signal /
    control field in `output`). Track as follow-up; switch away from throw once such an API exists.
  - User-side mitigation (pinning opencode-acp@1.16.0).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `lib/hooks.ts` stats/status/empty branch throws `__DCP_CONTEXT_HANDLED__` after `handleStatsCommand`
  - [ ] `lib/hooks.ts` context fallback branch throws `__DCP_CONTEXT_HANDLED__` after `handleContextCommand`
  - [ ] export/help branches unchanged (already correct)
- **Performance / Stability**:
  - [ ] No change to non-command code paths
- **Regression**:
  - [ ] New/modified test cases added to test suite and passing: every subcommand branch
        (stats/status/""/context/help/export) asserts the handler REJECTS with
        `__DCP_CONTEXT_HANDLED__` — this directly encodes "no subsequent prompt can be sent",
        preventing a future revert of throw→return (the exact gap that allowed PR #297's
        regression to survive 900+ tests)
  - [ ] The PR #297 test that asserted normal return ("issue #296") is flipped to assert the throw

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/hooks.ts` — `createCommandExecuteHandler` (2 lines: restore two throws)
  - `tests/hooks-permission.test.ts` — flip the #296 test; add per-branch regression tests
- **Risks**: Low. Restores previously shipped, field-proven behavior (v1.10.0–v1.16.0 all threw).
  The only behavioral delta vs v1.17.0/v1.18.0 is the ERROR log line on opencode ≥1.18.18 (#296),
  which is the accepted trade-off.
- **Rollback strategy**: Revert the single fix commit.
