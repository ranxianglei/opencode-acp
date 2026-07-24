# WORKLOG: Memory Tool

## Implementation

### Memory state (`lib/memory/state.ts`)
Pure helpers operating on `SessionState.memories`:
- `recordMemory(state, messageId, topic, logger)` — allocates `mem_NNN` id,
  stores `MemoryEntry`, increments `nextId`.
- `forgetMemory(state, id)` — sets `forgotten: true`, returns boolean.
- `listMemories(state)` — sorted by `createdAt`.
- `getActiveMemoryMessageIds(state)` — returns Set of forgotten entries'
  `messageId`s. Defensive: returns empty set if `state.memories` undefined
  (legacy test states / pre-migration sessions).

### Memory tool (`lib/memory/tool.ts`)
`createMemoryTool(ctx)` via `@opencode-ai/plugin` `tool()`. Args:
`{ topic: string, content: string }`. Uses `toolCtx.messageID` to link the
memory entry to the message containing the tool call (needed for forget-
unprotection). Returns confirmation with the memory id.

### Forget-unprotection (`lib/compress/protected-content.ts`)
`filterProtectedToolMessages` gains optional `unprotectedMessageIds?: Set<string>`.
Messages in this set skip the protected-tool check entirely → they CAN be
compressed. This is message-level granularity (not callID-level): the common
case (one memory call per assistant message) works perfectly. Edge case
(parallel memory calls in one message) is acceptable for MVP.

`lib/compress/range.ts` computes `getActiveMemoryMessageIds(ctx.state)` and
passes it to `filterProtectedToolMessages`.

### Persistence (`lib/state/persistence.ts`)
`memories` serialized as `{ entries: [[id, entry], ...], nextId: number }` in
`PersistedSessionState`. Loaded in `ensureSessionInitialized`. Survives restart.

### System prompt (`lib/prompts/system.ts`)
- Imports `MEMORY_GUIDELINES` from `context-compress-algorithms/prompts`
- Added `memory` tool to TOOLS section with usage example
- Added MEMORY section (the full `MEMORY_GUIDELINES`) after `HOW_TO_COMPRESS_RULES`
- Updated WHEN NOT TO COMPRESS: "Protected tool outputs (default: `skill` and
  `memory`)"

### Nudge reminder (`lib/messages/inject/inject.ts`)
After the compressible-ranges + "compress all in one call" hint, added:
"⚠️ Before compressing, scan each range for critical facts the task depends on
and record them with `memory` FIRST."

### Command (`lib/commands/memory.ts`)
`/acp memory` — list (default) or `forget <id>`. Uses `sendIgnoredMessage`
pattern matching other commands. Wired in `hooks.ts` dispatch +
`commands/index.ts` barrel + `help.ts`.

### Config (`lib/config.ts`)
`COMPRESS_DEFAULT_PROTECTED_TOOLS` changed from `["skill"]` to
`["skill", "memory"]`.

### index.ts
- Registers `memory: createMemoryTool(compressToolContext)`
- Adds `memory: "allow"` to default permissions

## Verification

- `npm run typecheck` — pass
- `npm test` — 851/851 pass (837 existing + 14 new)
- `npm run build` — pass; `MEMORY_GUIDELINES` text inlined (no external import)
