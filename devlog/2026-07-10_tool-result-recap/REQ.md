# REQ: Tool-Result Recap Injection

## Problem

Compression summaries were injected into the message stream as either:

- `role: "user"` (Bug 36 merge path) → model treated recaps as user instructions → goal drift (#78)
- `role: "assistant"` (Bug 37 standalone path) → model treated recaps as own prior output → verbatim echo (#20)

Both roles mislead the model because recaps are system metadata, not conversational turns.

## Solution

Inject compression summaries as **synthetic tool-call + tool-result pairs** using a dedicated `acp_context_recap` tool. At the API level, the model sees `role: "tool"` output — semantically neutral data that is neither user instruction nor own voice.

## Constraints

- Must not break prefix caching (no system prompt changes per turn)
- Must work across providers (OpenAI `role: "tool"`, Anthropic `tool_result` content type)
- Must not require opencode changes (use existing Message/Part types)
- GC system is being deprecated — do not reference it

## Acceptance Criteria

- [x] All compression summaries injected as `acp_context_recap` tool results
- [x] No `role: "user"` merge path
- [x] No `role: "assistant"` standalone text path
- [x] 599 tests pass
- [x] typecheck + build pass
- [x] System prompt updated with static `acp_context_recap` description
