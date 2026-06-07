# DESIGN - Expose decompress tool to AI model

- Task ID: `2026-06-07_model-decompress-tool`
- Home Repo: `opencode-acp`
- Created: 2026-06-07
- Status: Draft (Revised after dual-agent review)

## 1. Problem Statement

- **What problem are we solving?** ACP currently provides asymmetric context management — the model can `compress` but not `decompress`. When the model needs original details from a compressed block, it's stuck. Only human users can restore compressed content via `/acp decompress`. This limits the model's ability to manage context autonomously.
- **Why now?** The decompress command is battle-tested (283 lines, handles nested blocks, ancestor resolution, state persistence). Wrapping it as a tool is low-risk and high-value.

## 2. Goals & Non-Goals

- **Goals**:
  - Expose `decompress` as a model-accessible tool
  - Reuse existing decompress logic from `lib/commands/decompress.ts`
  - Return restored content inline so the model can reason immediately
  - Update system prompt with decompress usage guidance via conditional extension
  - Ensure model is aware of context budget before decompressing
  - Handle GC interaction after context inflation from decompress
  - Maintain backward compatibility with `/acp decompress` command
- **Non-Goals**:
  - Exposing `recompress` to the model (different risk profile, can be a follow-up)
  - Changing the `/acp decompress` command behavior
  - Adding new config options (use existing `compress.permission` to control both tools)
  - Modifying the GC system core — only adding awareness/documentation

## 3. Current Architecture

- **How it works today**:
  - `compress` tool: Registered in `index.ts` (L81-88), created by `createCompressRangeTool()` or `createCompressMessageTool()` in `lib/compress/`
  - `/acp decompress` command: `handleDecompressCommand()` in `lib/commands/decompress.ts` — sets `block.active=false`, `block.deactivatedByUser=true`, syncs, persists
  - Tool registration pattern: `tool({ description, args, execute })` from `@opencode-ai/plugin`
  - System prompt: `lib/prompts/system.ts` — mentions only `compress`
  - Pipeline: `prepareSession()`/`finalizeSession()` in `lib/compress/pipeline.ts` — compression-specific (dedup/purge, manual mode guard, compress notification)

- **Pain points**:
  - Model cannot recover compressed content autonomously
  - User intervention required for every decompress operation

## 4. Proposed Architecture

### Overview

```
index.ts
  └─► tool: { compress, decompress }     ← NEW: add decompress tool
        │
        ├─► compress tool (unchanged)
        │     ├─► prepareSession()         ← pipeline.ts (compression-specific)
        │     └─► finalizeSession()        ← pipeline.ts (compression-specific)
        │
        └─► decompress tool (NEW)         ← lib/compress/decompress.ts
              │
              ├─► prepareDecompressSession()  ← NEW: decompress-specific prepare
              ├─► resolveDecompressTarget()   ← extract shared logic from command
              ├─► deactivateBlocks()          ← extract shared logic from command
              ├─► syncCompressionBlocks()     ← existing
              ├─► buildRestoredContentPreview() ← NEW: condensed restored content
              └─► finalizeDecompressSession()  ← NEW: decompress-specific finalize
```

### Key Components

#### 4.1 New file: `lib/compress/decompress.ts`

A tool wrapper that reuses the decompress command's core logic:

```typescript
// Schema
{
  blockId: string  // Block reference: "b0", "b1", etc.
}

// Return value (shown to model) — includes restored content inline
"Decompressed block b2. Restored 5 messages (~2.1K tokens). Context usage: 38% → 52%.
Nested blocks b3 also restored.

RESTORED CONTENT (condensed):
[User] Asked about auth token refresh behavior in session middleware
[Assistant] Investigated lib/auth/session.ts — token refresh happens at L142-168...
[Tool:Read] lib/auth/session.ts (L140-170): refreshToken() checks expiry...
[Assistant] The refresh logic uses a sliding window...
..."
```

**Key design decisions**:

1. **Single `blockId` parameter** (not an array). Decompress is a targeted operation. Matches `/acp decompress <n>` UX pattern.

2. **Return restored content inline** (critical — Review #2 C2). After decompress, the model won't see restored messages until the **next turn**. Without inline content, the model wastes a turn doing "blind decompress". The tool returns a condensed preview (~2000 chars) of the restored messages so the model can reason immediately.

3. **Context usage feedback** (both reviewers). Include "Context usage: X% → Y%" in return value so the model can gauge impact.

#### 4.2 Decompress-specific prepare/finalize (critical — Review #1+ #2 C1)

**Do NOT reuse `prepareSession()`/`finalizeSession()` from `pipeline.ts`.** These are compression-specific:
- `prepareSession()` runs dedup/purge strategies and has a compress-specific manual mode guard message
- `finalizeSession()` transitions manual mode state and calls `sendCompressNotification()`

Instead, create lightweight decompress-specific functions:

```typescript
// lib/compress/decompress.ts

async function prepareDecompressSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<{ rawMessages: WithParts[] }> {
    // Permission check (reuse compress.permission)
    await toolCtx.ask({
        permission: "compress",  // shared permission
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title: "Decompress" })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client, ctx.state, toolCtx.sessionID,
        ctx.logger, rawMessages, ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)
    // NOTE: No dedup/purge strategies — those are compression-specific
    // NOTE: No manual mode guard — decompress is always allowed

    return { rawMessages }
}

async function finalizeDecompressSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<void> {
    await saveSessionState(ctx.state, ctx.logger)
    // NOTE: No manual mode state transition
    // NOTE: No compress notification — decompress uses tool return value instead
}
```

#### 4.3 Shared logic extraction

Extract reusable functions from `lib/commands/decompress.ts` into a shared module `lib/compress/decompress-logic.ts`:

| Function | Source | Used By |
|----------|--------|---------|
| `parseBlockIdArg()` | `decompress.ts` L24-37 | Tool + Command |
| `findActiveParentBlockId()` | `decompress.ts` L39-70 | Tool + Command |
| `findActiveAncestorBlockId()` | `decompress.ts` L72-84 | Tool + Command |
| `snapshotActiveMessages()` | `decompress.ts` L86-94 | Tool + Command |
| `deactivateCompressionTarget()` | Inline in command L232-245 | Tool + Command |
| `computeRestoredMessages()` | Inline in command L249-258 | Tool + Command |

The command and tool both call the same logic functions. The command adds UI formatting (available blocks listing, usage hints), the tool adds permission checks, inline content preview, and model-oriented feedback.

#### 4.4 Registration in `index.ts`

```typescript
tool: {
    ...(config.compress.permission !== "deny" && {
        compress: /* existing */,
        decompress: createDecompressTool(compressToolContext),  // NEW
    }),
},
```

Same permission gate as `compress` — if compress is denied, decompress is also denied.

#### 4.5 Primary tools config

In the `config` hook, add `decompress` to `primary_tools` alongside `compress`:

```typescript
if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
    toolsToAdd.push("compress", "decompress")
}
```

#### 4.6 System prompt update

**Use a conditional extension in `lib/prompts/extensions/system.ts`**, not base prompt modification (both reviewers).

Modify `lib/prompts/system.ts` base prompt:
```
The tools you have for context management are `compress` and `decompress`.
```

Add new `DECOMPRESS_SYSTEM_EXTENSION` in `lib/prompts/extensions/system.ts`:
```
THE PHILOSOPHY OF DECOMPRESS

`decompress` restores previously compressed content. Use it when you need exact details
that were lost in compression.

DECOMPRESS WHEN
- You need exact code, error messages, or file contents from a compressed block
- A summary lacks the precision needed for your next step
- You discovered the compressed content is still relevant

DO NOT DECOMPRESS IF
- Context usage is already high (>70%) — decompressing inflates context
- The summary is sufficient for your needs
- You plan to immediately recompress the same content

Before decompressing, check context usage. Decompressing restores full messages,
which can significantly increase context size.

NOTE: Message-mode blocks created in the same batch (same runId) are restored together.
Decompressing one block from a batch restores all blocks in that batch.
```

This extension is appended to the system prompt when decompress is enabled (i.e., when `compress.permission !== 'deny'`).

#### 4.7 Tool description (self-contained — Review #2 M3)

The tool description is self-contained in the tool definition, not using the extension pattern from `tool.ts`:

```typescript
tool({
    description: `Restores previously compressed content identified by a block ID.

Use this tool when you need exact details from a compressed block that the summary cannot provide.
The tool returns a condensed preview of the restored content so you can reason about it immediately.

Argument: blockId — the block reference to decompress (e.g., "b0", "b2")

IMPORTANT:
- Decompressing inflates context. Check context usage before decompressing.
- Message-mode blocks from the same batch (same runId) are restored together.
- After decompression, the restored messages will appear in full in your next context window.
- Do NOT call this tool in parallel with compress — their state mutations may conflict.`,
    // ...
})
```

#### 4.8 Protected tools default

Add `decompress` to the **`DEFAULT_PROTECTED_TOOLS` constant** in `config.ts` (L89-100):

```typescript
const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "decompress",   // NEW
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]
```

Also add to `COMPRESS_DEFAULT_PROTECTED_TOOLS`:
```typescript
const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread", "decompress"]
```

And to `commands.protectedTools` in the default config:
```typescript
commands: {
    protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "decompress", "batch", "plan_enter", "plan_exit", "write", "edit"],
}
```

And to `compress.protectedTools`:
```typescript
compress: {
    protectedTools: ["task", "skill", "todowrite", "todoread", "decompress"],
}
```

### Data Flow

```
Model calls decompress(blockId: "b2")
  │
  ▼
createDecompressTool.execute()
  │
  ├─► prepareDecompressSession() — permission check, fetch messages, init state, assign refs
  │     (NO dedup/purge, NO manual mode guard)
  │
  ├─► Parse blockId: "b2" → numeric block ID 2 (via parseBlockIdArg)
  │
  ├─► resolveCompressionTarget() — find the block in state
  │     ├─► Validate: block exists
  │     ├─► Validate: block is active
  │     └─► Handle nested: check ancestor blocks
  │
  ├─► snapshotActiveMessages() — record which messages are compressed (before)
  │
  ├─► deactivateCompressionTarget() — deactivate target + consumed inner blocks
  │     ├─► block.active = false, deactivatedByUser = true, deactivatedAt = now
  │     └─► Mark consumed inner blocks: consumedBlock.deactivatedByUser = true
  │
  ├─► syncCompressionBlocks() — recalculate active blocks, reactivate nested blocks
  │
  ├─► computeRestoredMessages() — diff snapshot vs current state
  │     └─► Count restored messages + tokens
  │     └─► Math.max(0, state.stats.totalPruneTokens - restoredTokens)  ← GUARD
  │
  ├─► buildRestoredContentPreview() — extract condensed restored content (~2000 chars)
  │     ├─► Find messages that were decompressed
  │     ├─► For each: extract role + truncated content (~200 chars each)
  │     └─► Total preview capped at ~2000 chars
  │
  ├─► finalizeDecompressSession() — save state (NO compress notification)
  │
  └─► Return result to model
        "Decompressed block b2. Restored 5 messages (~2.1K tokens). Context usage: 38% → 52%.
         Also restored nested block b3.

         RESTORED CONTENT (condensed):
         [User] Asked about auth token refresh...
         [Assistant] Investigated lib/auth/session.ts...
         ..."
```

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Tool parameter | A) Single `blockId` B) Array of block IDs C) Range-like start/end | A) Single `blockId` | Decompress is targeted (one block at a time). Array adds complexity without real benefit. Range doesn't make sense for decompress. |
| Shared logic location | A) Extract to `decompress-logic.ts` B) Import from command C) Duplicate | A) Extract to shared module | Clean separation, testable, both command and tool use identical logic |
| Permission model | A) Share `compress.permission` B) New `decompress.permission` config C) Always allow | A) Share existing permission | Compress and decompress are paired operations. If compress is denied, decompress is meaningless. Simpler config. |
| Prepare/finalize | A) Reuse pipeline.ts B) Decompress-specific | B) Decompress-specific | pipeline.ts is compression-specific (dedup/purge, manual mode guard, compress notification). Reusing would inject wrong behavior. |
| System prompt | A) Modify base system.ts B) Conditional extension in system.ts C) Extension in tool.ts | B) Conditional extension | Keeps base prompt minimal. Extension is appended only when decompress is enabled. Users can override via prompt store. |
| Tool description | A) Self-contained in tool definition B) Extension pattern from tool.ts | A) Self-contained | Decompress is simpler than compress (no format schema). Self-contained description is clearer and doesn't need the editable/prompt-store pattern. |
| Return content | A) Summary only B) Inline restored content | B) Inline restored content | Model won't see restored messages until next turn — "blind decompress" wastes a turn. Condensed preview (~2000 chars) gives immediate reasoning ability. |
| `deactivatedByUser` semantic | A) Same as command B) New flag for model-initiated | A) Same flag | Model-decompressed blocks should be recompressible via `/acp recompress`. Using the same flag ensures consistent behavior. |
| GC interaction | A) Suppress GC post-decompress B) Pre-decompress warning only C) Document risk only | B) Pre-decompress context check + document risk | Suppressing GC adds complexity and risk. Instead, the tool includes context usage in return value so the model can self-regulate. GC may deactivate other blocks after inflation — this is documented in the tool description. |

## 6. GC Interaction Analysis

**Problem**: Decompress inflates context by restoring original messages. On the next message-transform cycle, GC (`runMajorGC` in `hooks.ts`) may see elevated usage and aggressively deactivate other blocks or truncate old-gen summaries.

**Mitigations**:
1. **Tool returns context usage before/after** — model sees the impact and can decide to recompress
2. **Tool description warns about high context** — model should avoid decompressing when usage is already high
3. **Reactivated nested blocks retain stale `survivedCount`/`generation`** — GC may truncate them sooner than expected. This is acceptable because: (a) the model sees restored content inline and can act on it immediately, (b) if GC truncates, the model still had one turn with the information
4. **No GC suppression** — adding post-decompress GC suppression would require coupling between decompress tool and GC module, increasing complexity and risk. The GC's current behavior is conservative enough.

**Risk level**: Medium. Acceptable because decompress is a deliberate model action with inline feedback.

## 7. `deactivatedByUser` and Recompress Coupling

**Current behavior**: `deactivatedByUser=true` prevents blocks from being reactivated by `syncCompressionBlocks()` — they can only be restored via explicit decompress/recompress.

**Model decompress interaction**: When the model calls decompress, `deactivatedByUser=true` is set on the target block and its consumed inner blocks. This means:
- `/acp recompress` CAN restore these blocks (it explicitly re-runs compression on deactivated blocks)
- `syncCompressionBlocks()` will NOT reactivate them automatically
- This is the desired behavior — model-decompressed blocks should only be restored via explicit action

## 8. Impact Analysis

- **Backward compatibility**:
  - ✅ No changes to persisted state format
  - ✅ `/acp decompress` command unchanged
  - ✅ Config schema unchanged (reuses `compress.permission`)
  - ⚠️ System prompt text changes — "ONLY tool" → "tools... are" — users with custom prompt overrides via prompt store won't see the updated text (acceptable, same pattern as compress)
  - ⚠️ Default `protectedTools` arrays gain `decompress` — existing configs that override this array won't include it (acceptable, same pattern as existing tools)
- **Performance**: Negligible — decompress is synchronous state mutation, same as compress. Inline content preview adds ~2000 chars of string processing.
- **Security**: No new concerns — same permission gate as compress
- **Dependencies**: No new packages required

## 9. Migration Plan

- **Steps**:
  1. Create `lib/compress/decompress-logic.ts` with extracted shared functions
  2. Refactor `lib/commands/decompress.ts` to use shared functions
  3. Create `lib/compress/decompress.ts` tool with decompress-specific prepare/finalize + inline content preview
  4. Register in `index.ts` (tool + primary_tools)
  5. Update `lib/prompts/system.ts` base prompt text
  6. Add `DECOMPRESS_SYSTEM_EXTENSION` in `lib/prompts/extensions/system.ts`
  7. Update `DEFAULT_PROTECTED_TOOLS` + `COMPRESS_DEFAULT_PROTECTED_TOOLS` in `lib/config.ts`
  8. Update default config `commands.protectedTools` and `compress.protectedTools`
  9. Add tests
- **Feature flags / gradual rollout**: Uses existing `compress.permission` — setting it to `"deny"` disables both compress and decompress

## 10. Open Questions

- [RESOLVED] ~~Should the decompress tool also return the restored content inline, or just a summary?~~ **Decision**: Return condensed inline content (~2000 chars) — model can't see restored messages until next turn.
- [RESOLVED] ~~Should we add a config option `compress.decompressEnabled`?~~ **Decision**: No — adds config surface for minimal value. Can add later if needed.
- [RESOLVED] ~~Should the tool show context usage in return value?~~ **Decision**: Yes — include "Context usage: X% → Y%".
- [ ] Should reactivated nested blocks have their `survivedCount` reset to 0 to prevent immediate GC truncation? **Lean**: No — adds complexity, model gets one turn with the content regardless.
- [ ] Should the inline content preview length be configurable? **Lean**: No — 2000 chars is a reasonable default. Can add config later if needed.

## 11. Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `lib/compress/decompress-logic.ts` | **NEW** | Shared decompress logic extracted from command |
| `lib/compress/decompress.ts` | **NEW** | Decompress tool implementation with inline content preview |
| `lib/compress/index.ts` | MODIFY | Export new module |
| `lib/commands/decompress.ts` | MODIFY | Refactor to use shared logic from decompress-logic.ts |
| `index.ts` | MODIFY | Register decompress tool + primary_tools |
| `lib/prompts/system.ts` | MODIFY | Update base prompt: "ONLY tool" → "tools... are" |
| `lib/prompts/extensions/system.ts` | MODIFY | Add DECOMPRESS_SYSTEM_EXTENSION |
| `lib/config.ts` | MODIFY | Add `decompress` to DEFAULT_PROTECTED_TOOLS, COMPRESS_DEFAULT_PROTECTED_TOOLS, and default config protectedTools |
| `tests/decompress-tool.test.ts` | **NEW** | Tests for decompress tool |

## 12. Review History

| Date | Reviewer | Verdict | Key Issues |
|------|----------|---------|------------|
| 2026-06-07 | Oracle #1 | PASS WITH COMMENTS | pipeline.ts reuse is wrong (1 major), system prompt should use extension (agreed) |
| 2026-06-07 | Oracle #2 | FAIL | Must return restored content inline (C2), GC interaction (C3), decompress-specific prepare/finalize (C1), DEFAULT_PROTECTED_TOOLS missing (M1) |

All critical and major issues from both reviews are addressed in this revised design.
