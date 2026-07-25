# REQ: E2E Test for Subagent Compression

## Problem

PR #180 (remove subagent history rewriting) deleted a feature. Need to verify
that ACP compression inside subagent sessions still works correctly.

## Goal

Add an E2E test scenario that:
1. Spawns a child session via the `task` tool
2. Accumulates compressible messages inside the child
3. Calls `compress` inside the child
4. Verifies the child session's ACP state has a compression block

## Acceptance Criteria

- All 5 E2E scenarios pass (4 existing + 1 new)
- Parent session has 0 blocks (parent doesn't compress)
- Child session has 1 block (child compresses successfully)
- No changes to production code (`lib/`) required

## Technical Approach

- OpenCode sends `x-parent-session-id` HTTP header only on child session LLM
  requests — the fake LLM uses this to distinguish parent vs child
- Child session routing: separate turn counter, scenario `subagent_turns` array
- `extractMessageText` must also search `tool_calls[].function.arguments`
  because ACP injects `<dcp-message-id>` tags into tool-call-only assistant
  messages (not text content)
