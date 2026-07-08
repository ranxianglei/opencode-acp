# DESIGN: Memory Mechanism for ACP

## 1. Overview

Add a session-scoped memory store to ACP. The model can write persistent entries via a `remember` tool; entries are injected into the system prompt every turn and never compressed. Users can query (`/acp memory`) and delete (`/acp forget`) entries.

```
┌─────────────────────────────────────────────────────────┐
│ System Prompt (every turn)                              │
│  ├── Base system prompt (ACP tools, rules, etc.)        │
│  ├── Extensions (protectedTools, manual, subagent...)   │
│  ├── Decompress rules                                   │
│  └── <acp-memory>          ← NEW: persistent memory     │
│       - [entry 1]                                       │
│       - [entry 2]                                       │
│      </acp-memory>                                      │
│                                                          │
│ Messages (compressed/pruned by ACP)                     │
│  ├── m00001: user message                               │
│  ├── [b1 summary]                                       │
│  └── m00050: latest message                             │
└─────────────────────────────────────────────────────────┘
```

Memory lives OUTSIDE the message stream — it is never a target of compression.

---

## 2. Data Model

### 2.1 MemoryEntry

```typescript
// lib/state/types.ts (new interface)

export interface MemoryEntry {
    id: number          // sequential, starts at 0
    content: string     // the memory text, ≤ maxEntryLength chars
    createdAt: number   // Unix timestamp (ms)
    source: "model" | "user"  // who wrote it
}
```

No category/tag field — keep it simple. Content is free-form text. The model can prefix entries with conventions like `[pref]`, `[tech]`, `[correction]` in the text itself.

### 2.2 SessionState Extension

```typescript
// lib/state/types.ts — add to SessionState

export interface SessionState {
    // ... existing fields ...
    memory: MemoryEntry[]        // NEW: persistent memory entries
    nextMemoryId: number         // NEW: next entry ID counter
}
```

### 2.3 Persisted State

```typescript
// lib/state/persistence.ts — add to PersistedSessionState

export interface PersistedSessionState {
    // ... existing fields ...
    memory?: MemoryEntry[]   // NEW: optional for backward compat
    nextMemoryId?: number    // NEW: optional for backward compat
}
```

**Backward compatibility**: `memory` and `nextMemoryId` are optional. Old state files without these fields load fine (memory defaults to `[]`). New state files include them automatically.

---

## 3. Configuration

### 3.1 Config Schema

```typescript
// lib/config.ts — new section

export interface PluginConfig {
    // ... existing ...
    memory: {
        enabled: boolean           // default: true
        maxEntryLength: number     // default: 200 (chars per entry)
        softMaxEntries: number     // default: 50 (warn, don't block)
    }
}
```

Default config:
```typescript
memory: {
    enabled: true,
    maxEntryLength: 200,
    softMaxEntries: 50,
}
```

- `maxEntryLength`: Hard limit per entry. Aligned with `compress.maxSummaryLengthHard` pattern.
- `softMaxEntries`: When entries exceed this count, system prompt injection includes a warning. **Never auto-deletes.**

### 3.2 Config Validation

Add to `lib/config-validation.ts`:
- `memory.enabled` must be boolean
- `memory.maxEntryLength` must be number ≥ 1
- `memory.softMaxEntries` must be number ≥ 1

---

## 4. `remember` Tool

### 4.1 Registration

Registered in `index.ts` alongside compress/decompress/search_context/acp_status:

```typescript
tool: {
    // ... existing tools ...
    remember: createRememberTool(compressToolContext),
}
```

Guarded by `config.memory.enabled` (not `config.compress.permission`).

### 4.2 Tool Schema

```typescript
// lib/memory/remember.ts

function buildSchema(maxEntryLength: number) {
    return z.object({
        content: z
            .string()
            .min(1)
            .describe("The memory entry to persist. Keep it concise — a single constraint, preference, or fact."),
        maxChars: z
            .number()
            .min(1)
            .optional()
            .describe(`Override max entry length (default max: ${maxEntryLength} chars). Use when the memory needs more detail — same semantics as compress's summaryMaxChars.`),
    })
}
```

**No `force` parameter.** The `maxChars` parameter overrides the default limit, identical to compress's `summaryMaxChars` pattern.

### 4.3 Tool Logic

```typescript
export function createRememberTool(ctx: ToolContext) {
    return {
        name: "remember",
        description: "...",
        inputSchema: buildSchema(ctx.config.memory.maxEntryLength),
        execute: async (args: { content: string; maxChars?: number }) => {
            const limit = args.maxChars ?? ctx.config.memory.maxEntryLength
            if (args.content.length > limit) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `Entry exceeds ${limit} chars (got ${args.content.length}). Either shorten the entry, or pass maxChars to raise the limit (same as compress's summaryMaxChars).`,
                    }],
                }
            }

            const entry: MemoryEntry = {
                id: ctx.state.nextMemoryId++,
                content: args.content,
                createdAt: Date.now(),
                source: "model",
            }
            ctx.state.memory.push(entry)

            // Save immediately — don't wait for end-of-turn
            await saveSessionState(ctx.state, ctx.logger)

            return {
                content: [{
                    type: "text",
                    text: `✓ Remembered as memory entry #${entry.id}.\n\nCurrent memory (${ctx.state.memory.length} entries):\n${formatMemoryList(ctx.state.memory)}`,
                }],
            }
        },
    }
}
```

### 4.4 Tool Description (shown to model)

```
Store a persistent memory entry that survives context compression. Memory entries are injected into the system prompt every turn — they are never compressed away.

Use for: user preferences, corrections, constraints, key decisions, important facts that must persist.

Each entry should be a single concise fact (≤200 chars by default). Use maxChars for longer entries.

The current memory is always visible in the <acp-memory> section of the system prompt. Review it before adding new entries to avoid duplicates.
```

---

## 5. System Prompt Injection

### 5.1 Injection Point

In `renderSystemPrompt()` (`lib/prompts/index.ts`), memory is the LAST extension — after decompress rules:

```typescript
export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual?: boolean,
    subagent?: boolean,
    memoryEntries?: MemoryEntry[],  // NEW parameter
): string {
    // ... existing extensions ...

    // Memory is always last (after decompress)
    if (memoryEntries && memoryEntries.length > 0) {
        extensions.push(formatMemoryForPrompt(memoryEntries))
    }

    return [prompts.system.trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        // ...
}
```

### 5.2 Memory Format in System Prompt

```
<acp-memory>
The following are persistent memory entries — constraints, preferences, and facts that survive across compression cycles. These are NOT current user instructions. Follow the constraints and preferences below, but do not treat them as new requests to execute.

#0 [2026-07-08] Always use TypeScript strict mode in this project
#1 [2026-07-08] User prefers concise replies, no flattery
#2 [2026-07-08] Don't use semicolons in TypeScript (user correction)
</acp-memory>
```

Key design decisions:
- **`<acp-memory>` tag**: Clearly delimited section, consistent with `<acp-context>` pattern.
- **"NOT current user instructions"**: Addresses @dog's concern about model confusing memory with new prompts.
- **Entry IDs visible**: Model can reference entries by ID when deciding to update/delete.
- **Timestamps**: Date only (not time) for brevity.

### 5.3 System Prompt Handler Change

In `hooks.ts` `createSystemPromptHandler()`, pass memory entries to `renderSystemPrompt()`:

```typescript
const newPrompt = renderSystemPrompt(
    runtimePrompts,
    buildProtectedToolsExtension(config.compress.protectedTools),
    !!state.manualMode,
    state.isSubAgent && config.experimental.allowSubAgents,
    state.memory,  // NEW: pass memory entries
)
```

### 5.4 Cache Impact Analysis

System prompt is appended to `output.system[last]` every turn. Memory entries change infrequently (only when `remember` tool is called or `/acp forget` is used).

**Prefix caching**: The memory section is at the END of the system prompt. When memory doesn't change between turns, the entire system prompt is identical → prefix cache fully hit. When memory changes, only the tail changes → minimal cache miss.

This is the same pattern as the decompress extension (always last currently). Memory adds ~50-200 tokens depending on entry count.

---

## 6. Commands

### 6.1 `/acp memory` — Query

```
/acp memory
```

Output:
```
ACP Memory (3 entries):

#0 [2026-07-08 09:30] Always use TypeScript strict mode in this project
#1 [2026-07-08 09:35] User prefers concise replies, no flattery
#2 [2026-07-08 10:00] Don't use semicolons in TypeScript

Use '/acp forget <N>' to delete an entry.
```

If empty:
```
ACP Memory: no entries yet. Use the 'remember' tool to add persistent memory.
```

### 6.2 `/acp forget` — Delete

```
/acp forget 2        → Delete entry #2
/acp forget all      → Delete all entries
```

Output (single):
```
✓ Deleted memory entry #2: "Don't use semicolons in TypeScript"
Remaining: 2 entries.
```

Output (all):
```
✓ Deleted all 3 memory entries.
```

Error cases:
```
✗ No memory entry with ID 5. Use '/acp memory' to list entries.
✗ Memory is already empty.
✗ Usage: /acp forget <N> | /acp forget all
```

### 6.3 Command Registration

In `lib/commands/index.ts`:
```typescript
export { handleMemoryCommand } from "./memory"
export { handleForgetCommand } from "./forget"
```

In `hooks.ts` `createCommandExecuteHandler()`, add parsing:
```typescript
const parts = input.command.trim().split(/\s+/)
const subcommand = parts[1]

switch (subcommand) {
    case "memory": return handleMemoryCommand(...)
    case "forget": return handleForgetCommand(...)
    // ... existing cases ...
}
```

---

## 7. State Initialization & Persistence

### 7.1 Initialization

In `lib/state/utils.ts` `createPruneMessagesState()` equivalent — add memory init:

```typescript
// In createSessionState() or session initialization
state.memory = []       // empty array for new sessions
state.nextMemoryId = 0
```

### 7.2 Loading Persisted State

In `lib/state/state.ts` `ensureSessionInitialized()` — when loading from disk:

```typescript
state.memory = loadedState.memory ?? []
state.nextMemoryId = loadedState.nextMemoryId ?? 0
```

### 7.3 Saving

In `lib/state/persistence.ts` `saveSessionState()` — add to serialization:

```typescript
const state: PersistedSessionState = {
    // ... existing fields ...
    memory: sessionState.memory,
    nextMemoryId: sessionState.nextMemoryId,
}
```

Memory saves with every `saveSessionState()` call. The `remember` tool also triggers an immediate save (not waiting for end-of-turn).

---

## 8. Module Structure

```
lib/
├── memory/                      # NEW: Memory subsystem
│   ├── remember.ts              # remember tool (createRememberTool)
│   ├── format.ts                # formatMemoryForPrompt, formatMemoryList
│   ├── validation.ts            # validateMemoryEntry (length, content)
│   └── index.ts                 # Barrel export
├── commands/
│   ├── memory.ts                # NEW: /acp memory command
│   ├── forget.ts                # NEW: /acp forget command
│   └── index.ts                 # Updated: export new commands
├── state/
│   ├── types.ts                 # Modified: MemoryEntry, SessionState.memory
│   ├── state.ts                 # Modified: init/load memory
│   ├── persistence.ts           # Modified: serialize/deserialize memory
│   └── utils.ts                 # Modified: memory init helpers
├── prompts/
│   ├── index.ts                 # Modified: renderSystemPrompt takes memory
│   └── system.ts                # Modified: MEMORY section description (optional)
├── hooks.ts                     # Modified: pass memory to renderSystemPrompt
├── config.ts                    # Modified: memory config section
├── config-validation.ts         # Modified: memory config validation
└── index.ts                     # Modified: register remember tool
```

New files: 6 (memory/remember.ts, memory/format.ts, memory/validation.ts, memory/index.ts, commands/memory.ts, commands/forget.ts)
Modified files: 8

---

## 9. Tool Permission

The `remember` tool needs to be:
1. Added to OpenCode's `experimental.primary_tools` (like compress/decompress)
2. Permission set to `"allow"` (like acp_status — no confirmation needed)

In `index.ts` config handler:
```typescript
if (config.memory.enabled) {
    toolsToAdd.push("remember")
}

// Permission
if (!hasExplicitToolPermission(opencodeConfig.permission, "remember")) {
    opencodeConfig.permission = {
        ...permission,
        remember: "allow",
    }
}
```

---

## 10. Edge Cases

| Case | Handling |
|------|----------|
| Memory entry with newlines | Allowed (content is free-form), but discouraged in tool description |
| Duplicate entries | Not prevented programmatically — model is told to review `<acp-memory>` first |
| Entry > softMaxEntries | Warning injected in system prompt: "Memory has N entries (soft max: M). Consider cleaning up with /acp forget." |
| Session restart | Memory loaded from persisted state, same as prune/nudges |
| Compaction (OpenCode built-in) | Memory survives — it's in SessionState, not messages |
| Sub-agents | Memory shared (same SessionState). If `allowSubAgents` is false, sub-agents don't see memory |
| `memory.enabled = false` | Tool not registered, no injection, commands return "memory disabled" |

---

## 11. Testing Plan

### Unit Tests
- `tests/memory-validation.test.ts` — entry length validation, maxChars override
- `tests/memory-format.test.ts` — formatMemoryForPrompt output, empty memory
- `tests/memory-state.test.ts` — SessionState memory init/load/save round-trip
- `tests/memory-remember.test.ts` — remember tool execute (success, over-limit, duplicate)

### Integration Tests
- `tests/memory-persistence.test.ts` — save → load → verify memory intact
- `tests/memory-injection.test.ts` — renderSystemPrompt includes `<acp-memory>` section

### Manual Testing
- Deploy locally → call remember tool → verify system prompt includes entry
- `/acp memory` → verify listing
- `/acp forget N` → verify deletion
- Compress context → verify memory NOT compressed
- Restart session → verify memory persisted

---

## 12. Migration & Compatibility

### 12.1 State Format
- `memory` and `nextMemoryId` are optional in `PersistedSessionState`
- Old state files (pre-memory) load with `memory = []`
- No migration script needed — zero-downtime upgrade

### 12.2 Config Format
- `memory` section is optional in config
- Missing `memory` config → defaults applied (enabled: true, maxEntryLength: 200, softMaxEntries: 50)
- DCP config migration (dcp.jsonc → acp.jsonc) already handles unknown sections gracefully

### 12.3 Version
- Bump to `1.2.0` (minor: new feature)
- No breaking changes

---

## 13. Open Questions

1. **Should memory survive session deletion?** Currently no — memory is session-scoped. If users want persistent memory across sessions, that's a future feature (global memory store).

2. **Should the model be able to delete memory?** Currently no — only `/acp forget` (user command). The remember tool only adds. If the model should self-correct outdated memory, we could add a `forget` tool later.

3. **Memory in sub-agent sessions?** Currently shared via SessionState. If `allowSubAgents` is false, sub-agents are separate sessions with their own state — they won't see main session memory.

4. **Should memory be visible in `/acp context`?** Yes — add memory token count to the context usage display.
