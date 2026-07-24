# REQ: Memory Tool — durable facts that survive compression

## Problem

Compression summaries lose fidelity over time (model paraphrases, GC truncates
old-gen blocks). Critical facts — user constraints, irreversible decisions, exact
values, goal pivots — need a survival path independent of compression. Today the
only option is to keep them in raw context, which competes with active work for
context budget, or embed them in summaries, which decay.

## Solution

A standalone `memory` tool the model calls to record a durable fact. Memories
are **permanent and protected from compression** — they survive every compress
via Bug 39 hard-exclusion (the memory tool is registered in
`compress.protectedTools`). The model sees its own past `memory({topic, content})`
calls as anchors, same pattern as v1.12.9 compress-as-anchor.

### Key design decisions

1. **Standalone tool, not a compress flag.** Decouples memory from compression
   lifecycle. Recordable any time, no char/quality limits, no nesting complexity.
2. **Survival via protection, not new logic.** `"memory"` in
   `COMPRESS_DEFAULT_PROTECTED_TOOLS` → existing `filterProtectedToolMessages`
   excludes memory tool-call messages from compress ranges. Zero new protection
   code.
3. **Forget = lose protection.** `/acp memory forget <id>` marks the memory
   forgotten in state. `filterProtectedToolMessages` gains an
   `unprotectedMessageIds` param; forgotten memory messages are not protected →
   the next compress that covers them consumes them. (ACP cannot delete messages,
   so cleanup is deferred to natural compression.)
4. **Compress-time reminder.** The nudge (`inject.ts`) prepends "record memory
   before compressing" so the model captures facts while content is still visible.
5. **Guidance from cc-alg.** `MEMORY_GUIDELINES` (when to record vs. compress,
   content guidance, compression interaction) lives in MIT-licensed
   `context-compress-algorithms@1.1.0` and is interpolated into the system prompt.

## Scope

### New files
- `lib/memory/state.ts` — `recordMemory`, `forgetMemory`, `listMemories`,
  `getActiveMemoryMessageIds`, `formatMemoryId`
- `lib/memory/tool.ts` — `createMemoryTool` factory (`{topic, content}` args)
- `lib/memory/index.ts` — barrel
- `lib/commands/memory.ts` — `/acp memory [list | forget <id>]`
- `tests/memory-feature.test.ts` — 14 tests

### Modified files
- `lib/state/types.ts` — `MemoryEntry`, `MemoryState` types; `memories` on
  `SessionState`
- `lib/state/state.ts` — init/reset/load memories
- `lib/state/persistence.ts` — serialize/deserialize memories
- `lib/compress/protected-content.ts` — `unprotectedMessageIds` param on
  `filterProtectedToolMessages`
- `lib/compress/range.ts` — pass forgotten memory messageIds
- `lib/config.ts` — `"memory"` in `COMPRESS_DEFAULT_PROTECTED_TOOLS`
- `lib/prompts/system.ts` — MEMORY section + memory tool in TOOLS + WHEN NOT TO
  COMPRESS
- `lib/messages/inject/inject.ts` — "record before compress" nudge reminder
- `lib/hooks.ts` — `/acp memory` dispatch
- `lib/commands/index.ts` — barrel export
- `lib/commands/help.ts` — help listing
- `index.ts` — register memory tool + permission
- `package.json` — `context-compress-algorithms` `^1.0.0` → `^1.1.0`

## Acceptance Criteria

- [x] `memory` tool registered and callable by the model
- [x] Memory tool-call messages survive compression (protected)
- [x] `/acp memory forget <id>` loses protection → next compress consumes it
- [x] System prompt includes MEMORY_GUIDELINES from cc-alg
- [x] Compress nudge reminds model to record before compressing
- [x] Memories persist across session restart (persistence layer)
- [x] `npm run typecheck` passes
- [x] `npm test` passes (851 tests)
- [x] `npm run build` passes
