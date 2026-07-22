# WORKLOG: Subagent E2E Compression Test

## Iteration 1 — 2026-07-23

### Investigation

- Confirmed OpenCode sends `x-parent-session-id` header on child session LLM
  requests (from OpenCode source `session/llm/request.ts:187-205`)
- Probe experiment confirmed `task` tool creates child sessions with `parentID`
- ACP's `assignMessageRefs` and `injectMessageIds` work correctly in subagent
  sessions when `experimental.allowSubAgents: true`

### Implementation

**`scripts/e2e/fake-llm-server.ts`**:
- Added `task` and `tool` response types to `ScenarioStep`
- Child detection via `x-parent-session-id` header
- `handleChildRequest()`: routes child turns from `subagent_turns` array
- `handleTaskStep()`: emits `task` tool_use call
- `toolUseResponse()`: generic SSE streaming for arbitrary tool names
- Fixed `extractMessageText` to search `tool_calls[].function.arguments`
  (ACP injects `<dcp-message-id>` tags into tool-call-only assistant messages)

**`scripts/e2e/scenarios/05-subagent-compress.json`**:
- Parent turn: emit `task` with `subagent_type: "general"`
- Child turns: 3× bash (accumulate content) → compress (m00001-m00003) → text
- Verify: `blockCount: 0, childBlockCount: 1`

**`scripts/e2e/run-e2e.sh`**:
- Added `agent.general` definition to opencode.json
- Added `task`/`bash` permissions
- Added `experimental.allowSubAgents: true` to acp.jsonc
- Pass `ACP_DIR` to verify.ts for child state discovery

**`scripts/e2e/verify.ts`**:
- Added `childBlockCount` assertion
- Discovers child state files by scanning ACP directory

### Verification

```
E2E RESULTS: 5 passed, 0 failed
```

Child compress log confirms: `found 3 mNNNNN refs: m00001..m00003` →
`compress: m00001..m00003, summary=647 chars, ack=true`

### Key Finding

ACP's production code (`lib/hooks.ts`, `lib/message-ids.ts`) requires NO changes
for subagent compression — existing code handles it correctly when
`allowSubAgents: true` is set.
