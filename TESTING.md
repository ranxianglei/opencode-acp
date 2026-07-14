# Testing Guide — opencode-acp

> Practical reference for writing and running tests. All test files live flat in `tests/*.test.ts`.

---

## Running Tests

```bash
# Run all tests
npm test
# Equivalent to:
node --import tsx --test tests/*.test.ts

# Run a single test file
node --import tsx --test tests/token-counting.test.ts

# Run multiple specific files
node --import tsx --test tests/message-ids.test.ts tests/message-utils.test.ts
```

**Current baseline:** 134 passing tests across 16 test files (with 3 known failures in `config-validation.test.ts`).

No CI/CD is configured. Tests run locally.

---

## Test Framework

| Layer       | Technology                              | Import                                    |
| ----------- | --------------------------------------- | ----------------------------------------- |
| Test runner | Node.js built-in (`node:test`)          | `import test from "node:test"`            |
| Assertions  | Node.js built-in (`node:assert/strict`) | `import assert from "node:assert/strict"` |
| TypeScript  | `tsx` (on-the-fly transpilation)        | `--import tsx` flag                       |

No external test libraries (Jest, Vitest, Mocha) are used. Everything is the Node.js built-in test runner.

### Key Assertion Patterns

```typescript
assert.equal(actual, expected) // Strict equality
assert.deepEqual(actual, expected) // Deep structural equality
assert.match(string, /regex/) // Regex match
assert.doesNotMatch(string, /regex/) // Regex non-match
assert.rejects(asyncFn, /error pattern/) // Promise rejection
```

---

## Test Categories

### Unit Tests — Pure Functions

Zero external dependencies. Test deterministic logic in isolation.

| Test File                  | Source Module                                                                                                                                 | What It Tests                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `token-counting.test.ts`   | `lib/token-utils.ts`                                                                                                                          | `countAllMessageTokens`, `countToolTokens`, `estimateTokensBatch`, `extractToolContent`, `extractCompletedToolOutput` |
| `message-ids.test.ts`      | `lib/message-ids.ts`, `lib/state/state.ts`                                                                                                    | `assignMessageRefs`, `checkSession` (ID reset after native compaction)                                                |
| `message-utils.test.ts`    | `lib/messages/query.ts`                                                                                                                       | `isIgnoredUserMessage`                                                                                                |
| `message-priority.test.ts` | `lib/messages/priority.ts`, `lib/messages/inject/inject.ts`, `lib/messages/inject/utils.ts`, `lib/messages/prune.ts`, `lib/messages/utils.ts` | `buildPriorityMap`, `injectMessageIds`, `applyAnchoredNudges`, `prune`, `stripHallucinationsFromString`               |
| `input-budget.test.ts`     | `lib/messages/inject/utils.ts`                                                                                                                | `computeInputBudget`                                                                                                  |
| `host-permissions.test.ts` | `lib/host-permissions.ts`                                                                                                                     | `compressDisabledByOpencode`, `hasExplicitToolPermission`, `resolveEffectiveCompressPermission`                       |
| `update.test.ts`           | `lib/update.ts`                                                                                                                               | `isVersionNewer`, `isAutoUpdatableSpec`, `updateRemoveDir`                                                            |

### Functional Tests — Module Behavior with Mock Data

Mocked dependencies (client, filesystem). Test real module logic end-to-end.

| Test File                             | Source Module                                                                                                  | What It Tests                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compress-message.test.ts`            | `lib/compress/message.ts`                                                                                      | `createCompressMessageTool` — batch compression, protected content, error handling, notification                                                                                      |
| `compress-range.test.ts`              | `lib/compress/range.ts`                                                                                        | `createCompressRangeTool` — subagent sessions, protected tags, batch notifications, overlap rejection                                                                                 |
| `compress-range-placeholders.test.ts` | `lib/compress/range-utils.ts`, `lib/compress/state.ts`                                                         | `parseBlockPlaceholders`, `injectBlockPlaceholders`, `validateSummaryPlaceholders`, `appendMissingBlockSummaries`, `wrapCompressedSummary`                                            |
| `compression-groups.test.ts`          | `lib/compress/message.ts`, `lib/compress/range.ts`, `lib/commands/decompress.ts`, `lib/commands/recompress.ts` | Grouped run lifecycle: compress → decompress → recompress across both modes                                                                                                           |
| `compression-targets.test.ts`         | `lib/commands/compression-targets.ts`                                                                          | `getActiveCompressionTargets` — grouping by `runId`, duration aggregation                                                                                                             |
| `hooks-permission.test.ts`            | `lib/hooks.ts`                                                                                                 | `createChatMessageTransformHandler`, `createCommandExecuteHandler`, `createTextCompleteHandler`, `createEventHandler` — permission enforcement, hallucination stripping, event timing |
| `prompts.test.ts`                     | `lib/prompts/store.ts`, `lib/prompts/system.ts`                                                                | `PromptStore` — defaults, overrides, file-based loading                                                                                                                               |
| `token-usage.test.ts`                 | `lib/messages/inject/utils.ts`, `lib/compress/state.ts`, `lib/token-utils.ts`                                  | `isContextOverLimits`, `wrapCompressedSummary`, `getCurrentTokenUsage` — context threshold calculation                                                                                |

### E2E Tests — Full Pipeline

Not yet implemented. Will test the complete message transform pipeline from `hooks.ts` through all stages.

---

## Current Test Coverage

### Modules WITH Tests

| Source Module                         | Test File(s)                                                              | Key Functions Covered                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/token-utils.ts`                  | `token-counting.test.ts`, `token-usage.test.ts`                           | `countAllMessageTokens`, `countToolTokens`, `estimateTokensBatch`, `extractToolContent`, `extractCompletedToolOutput`, `getCurrentTokenUsage` |
| `lib/message-ids.ts`                  | `message-ids.test.ts`                                                     | `assignMessageRefs`                                                                                                                           |
| `lib/state/state.ts`                  | `message-ids.test.ts`                                                     | `checkSession`                                                                                                                                |
| `lib/state/utils.ts`                  | (indirect via other tests)                                                | `isMessageCompacted`, `serializePruneMessagesState`                                                                                           |
| `lib/messages/query.ts`               | `message-utils.test.ts`                                                   | `isIgnoredUserMessage`                                                                                                                        |
| `lib/messages/shape.ts`               | `message-utils.test.ts`                                                   | `isMessageWithInfo` (indirect)                                                                                                                |
| `lib/messages/priority.ts`            | `message-priority.test.ts`                                                | `buildPriorityMap`                                                                                                                            |
| `lib/messages/inject/inject.ts`       | `message-priority.test.ts`                                                | `injectMessageIds`                                                                                                                            |
| `lib/messages/inject/utils.ts`        | `input-budget.test.ts`, `token-usage.test.ts`, `message-priority.test.ts` | `computeInputBudget`, `isContextOverLimits`, `applyAnchoredNudges`                                                                            |
| `lib/messages/prune.ts`               | `message-priority.test.ts`                                                | `prune`                                                                                                                                       |
| `lib/messages/utils.ts`               | `message-priority.test.ts`                                                | `stripHallucinationsFromString`                                                                                                               |
| `lib/compress/message.ts`             | `compress-message.test.ts`, `compression-groups.test.ts`                  | `createCompressMessageTool`                                                                                                                   |
| `lib/compress/range.ts`               | `compress-range.test.ts`, `compression-groups.test.ts`                    | `createCompressRangeTool`                                                                                                                     |
| `lib/compress/range-utils.ts`         | `compress-range-placeholders.test.ts`                                     | `parseBlockPlaceholders`, `injectBlockPlaceholders`, `validateSummaryPlaceholders`, `appendMissingBlockSummaries`                             |
| `lib/compress/state.ts`               | `compress-range-placeholders.test.ts`, `token-usage.test.ts`              | `wrapCompressedSummary`                                                                                                                       |
| `lib/commands/compression-targets.ts` | `compression-targets.test.ts`                                             | `getActiveCompressionTargets`                                                                                                                 |
| `lib/commands/decompress.ts`          | `compression-groups.test.ts`                                              | `handleDecompressCommand`                                                                                                                     |
| `lib/commands/recompress.ts`          | `compression-groups.test.ts`                                              | `handleRecompressCommand`                                                                                                                     |
| `lib/hooks.ts`                        | `hooks-permission.test.ts`                                                | `createChatMessageTransformHandler`, `createCommandExecuteHandler`, `createTextCompleteHandler`, `createEventHandler`                         |
| `lib/prompts/store.ts`                | `prompts.test.ts`                                                         | `PromptStore`                                                                                                                                 |
| `lib/host-permissions.ts`             | `host-permissions.test.ts`                                                | `compressDisabledByOpencode`, `resolveEffectiveCompressPermission`                                                                            |
| `lib/update.ts`                       | `update.test.ts`                                                          | `isVersionNewer`, `isAutoUpdatableSpec`, `updateRemoveDir`                                                                                    |

### Modules WITHOUT Tests

| Source Module                     | Key Untested Functions                                                                                             | Complexity                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `lib/config.ts`                   | Config merging, defaults, validation, DCP migration                                                                | ~1125 lines, largest file  |
| `lib/state/persistence.ts`        | `saveSessionState`, `loadSessionState`, `ensureSessionInitialized`, DCP migration                                  | ~295 lines, filesystem I/O |
| `lib/state/utils.ts` (direct)     | `isMessageCompacted`, `serializePruneMessagesState`, `deserializePruneMessagesState`, `getActiveSummaryTokenUsage` | ~358 lines                 |
| `lib/messages/prune.ts`           | `filterCompressedRanges`, `pruneToolOutputs`, `pruneToolInputs`, `pruneToolErrors`                                 | ~263 lines                 |
| `lib/messages/sync.ts`            | `syncCompressionBlocks` — deactivate orphaned blocks                                                               | ~130 lines                 |
| `lib/messages/inject/inject.ts`   | `injectCompressNudges`, `injectMessageIds`                                                                         | ~280 lines                 |
| `lib/gc/truncate.ts`              | `runTruncateGC`, `truncateSummary`                                                                                 | ~83 lines, pure logic      |
| `lib/strategies/deduplication.ts` | `deduplicate` — same tool + args pruning                                                                           | ~127 lines                 |
| `lib/strategies/purge-errors.ts`  | `purgeErrors` — errored tool input pruning                                                                         | ~88 lines                  |
| `lib/compress-permission.ts`      | `compressPermission`, `syncCompressPermissionState`                                                                | ~25 lines                  |
| `lib/protected-patterns.ts`       | `matchesGlob`, `isFilePathProtected`, `isToolNameProtected`, `getFilePathsFromParameters`                          | ~128 lines, pure logic     |
| `lib/commands/context.ts`         | Context usage display command                                                                                      | Slash command handler      |
| `lib/commands/stats.ts`           | Compression statistics command                                                                                     | Slash command handler      |
| `lib/commands/sweep.ts`           | Force full context sweep command                                                                                   | Slash command handler      |
| `lib/commands/manual.ts`          | Manual mode toggle command                                                                                         | Slash command handler      |
| `lib/commands/help.ts`            | Help display command                                                                                               | Slash command handler      |
| `lib/ui/notification.ts`          | `buildMinimalMessage`, `buildDetailedMessage`                                                                      | ~357 lines                 |

---

## Test Data Patterns

All tests construct mock data inline using helper functions. There are no shared test fixtures or external data files.

### Building `PluginConfig`

Every test file creates its own `buildConfig()` helper. The pattern is consistent:

```typescript
import type { PluginConfig } from "../lib/config"

function buildConfig(mode: "message" | "range" = "message"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode,
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}
```

Variations: Some tests add the `gc` field, `summaryBuffer`, or `modelMaxLimits` depending on what they test.

### Building `WithParts` Messages

Two common patterns. The **simple** one-message builder:

```typescript
function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
    created: number,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created },
              }
            : { id, role, sessionID, agent: "assistant", time: { created } }

    return {
        info: info as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}
```

The **multi-message** builder (`buildMessages`) returns an array representing a mini-conversation:

```typescript
function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
        },
    ]
}
```

### Building Parts

**Text part:**

```typescript
function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}
```

**Tool part:**

```typescript
function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}
```

### Building `SessionState`

Always via the factory function:

```typescript
import { createSessionState } from "../lib/state"

const state = createSessionState()
state.sessionId = "session-1"
```

Manually populate blocks when needed:

```typescript
state.prune.messages.blocksById.set(1, {
    blockId: 1,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: 0,
    durationMs: 0,
    mode: "message",
    topic: "one",
    batchTopic: "one",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "msg-a",
    compressMessageId: "message-1",
    compressCallId: "call-1",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: ["msg-a"],
    effectiveToolIds: [],
    createdAt: 1,
    summary: "a",
    survivedCount: 0,
    generation: "young",
})
```

Or use the `buildBlock()` helper from `compression-targets.test.ts`:

```typescript
function buildBlock(
    blockId: number,
    runId: number,
    mode: "range" | "message",
    durationMs: number,
): CompressionBlock {
    return {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs,
        mode,
        topic: `topic-${blockId}`,
        batchTopic: mode === "message" ? `batch-${runId}` : `topic-${blockId}`,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `origin-${runId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
        survivedCount: 0,
        generation: "young",
    }
}
```

### Mocking the Client

Tests that call compress tools or hook handlers mock the `client` parameter as `any`:

```typescript
const tool = createCompressRangeTool({
    client: {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
    },
    state,
    logger,
    config: buildConfig(),
    prompts: {
        reload() {},
        getRuntimePrompts() {
            return { compressRange: "", compressMessage: "" }
        },
    },
} as any)
```

For toast notification capture:

```typescript
const toastCalls: string[] = []
const tool = createCompressRangeTool({
    client: {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
        },
        tui: {
            showToast: async ({ body }: { body: { message: string } }) => {
                toastCalls.push(body.message)
            },
        },
    },
    // ...
} as any)
```

### Filesystem Isolation

Tests that touch persistence set temp directories:

```typescript
const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })
```

---

## Writing New Tests

### Step-by-Step

1. **Identify the source module.** Read the source file to understand the public API (exported functions).
2. **Choose the test tier.** Is it a pure function (Tier 1), needs mock data (Tier 2), or needs integration (Tier 3)? See the priority table below.
3. **Create the test file.** Name it `tests/{module-name}.test.ts` (e.g., `tests/protected-patterns.test.ts`).
4. **Write the boilerplate.** Use the template below.
5. **Write test cases.** Start with happy path, then edge cases, then error cases.
6. **Run the test.** `node --import tsx --test tests/{module-name}.test.ts`
7. **Run all tests.** `npm test` — verify nothing breaks.

### Template

```typescript
import assert from "node:assert/strict"
import test from "node:test"

// Import what you're testing
import { yourFunction } from "../lib/your-module"

// Optional: import types you need for mock data
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"

// --- Helper functions (copy from existing tests as needed) ---

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

// --- Tests ---

test("yourFunction does X when Y", () => {
    // Arrange
    const input = /* ... */

    // Act
    const result = yourFunction(input)

    // Assert
    assert.equal(result, expected)
})

test("yourFunction handles edge case Z", () => {
    // ...
})
```

### Naming Conventions

- Test files: `{module-name}.test.ts` — matches the source module path (e.g., `lib/protected-patterns.ts` → `tests/protected-patterns.test.ts`)
- Test descriptions: Full sentences describing the behavior, e.g., `"compress message mode rejects compressed block ids"`
- Helper functions: `buildConfig()`, `buildMessage()`, `buildMessages()`, `textPart()`, `toolPart()`, `buildBlock()`

### Tips

- **Copy helpers, don't import them.** Every test file defines its own `buildConfig()` and `buildMessage()` helpers. This keeps tests self-contained and avoids shared mutable state.
- **Use `as any` freely for mock client objects.** The OpenCode client SDK types are verbose. Tests only implement the methods they call.
- **Use `Date.now` mocking** for timing tests (see `hooks-permission.test.ts` lines 199–381).
- **Unique session IDs** prevent test pollution: `` const sessionID = `ses_test_name_${Date.now()}` ``

---

## Module Test Priority Table

Prioritize by ease of testing and impact. Pure functions first, then mock-data tests, then integration.

### Tier 1 — Pure Functions (Zero Dependencies)

Quick wins. No mocking needed. Test input → output directly.

| Module                       | Functions to Test                                                                            | Why Easy                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `lib/protected-patterns.ts`  | `matchesGlob`, `isFilePathProtected`, `isToolNameProtected`, `getFilePathsFromParameters`    | Pure string matching, no I/O                                |
| `lib/gc/truncate.ts`         | `runTruncateGC`, `truncateSummary`                                                           | Pure array transformation, inputs/outputs are plain objects |
| `lib/compress-permission.ts` | `compressPermission`, `syncCompressPermissionState`                                          | Simple delegation, tiny module                              |
| `lib/messages/shape.ts`      | `isMessageWithInfo`, `filterMessages`                                                        | Pure type guards                                            |
| `lib/messages/query.ts`      | `isIgnoredUserMessage`, `getLastUserMessage`, `messageHasCompress`, `isProtectedUserMessage` | Pure predicates, just need `WithParts` objects              |

### Tier 2 — Mock Data Required

Need `SessionState`, `PluginConfig`, or `WithParts[]` construction. Still no I/O.

| Module                            | Functions to Test                                                                    | Mock Data Needed                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `lib/strategies/deduplication.ts` | `deduplicate`                                                                        | `SessionState` + `WithParts[]` with tool parts                   |
| `lib/strategies/purge-errors.ts`  | `purgeErrors`                                                                        | `SessionState` + `WithParts[]` with errored tool parts           |
| `lib/messages/prune.ts`           | `filterCompressedRanges`, `pruneToolOutputs`, `pruneToolInputs`                      | `SessionState` with blocks, `WithParts[]`, `Logger`              |
| `lib/messages/sync.ts`            | `syncCompressionBlocks`                                                              | `SessionState` with blocks, `WithParts[]` (partial message list) |
| `lib/messages/inject/inject.ts`   | `injectCompressNudges`                                                               | Full `SessionState` + config + messages + prompts                |
| `lib/state/utils.ts`              | `isMessageCompacted`, `serializePruneMessagesState`, `deserializePruneMessagesState` | `SessionState`, plain objects                                    |
| `lib/messages/priority.ts`        | `buildPriorityMap`                                                                   | Covered, but more edge cases possible                            |

### Tier 3 — Filesystem or Integration

Need temp directories, file I/O, or multi-module orchestration.

| Module                     | Functions to Test                                                  | Why Hard                                        |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `lib/config.ts`            | Config loading, merging, validation, migration                     | Filesystem reads, JSONC parsing, DCP migration  |
| `lib/state/persistence.ts` | `saveSessionState`, `loadSessionState`, `ensureSessionInitialized` | File I/O, JSON serialization, DCP migration     |
| `lib/commands/*.ts`        | Command handlers                                                   | Full client mock needed, output formatting      |
| `lib/ui/notification.ts`   | `buildMinimalMessage`, `buildDetailedMessage`                      | Needs full `SessionState` with blocks and stats |
| `lib/hooks.ts`             | Full pipeline integration                                          | Orchestrates all other modules                  |

---

## Common Pitfalls

1. **Forgetting `survivedCount` and `generation` on `CompressionBlock`.** The type makes them required. Always include `survivedCount: 0` and `generation: "young"` when building blocks.

2. **Missing `model` field on user message `info`.** User messages in the SDK have `model: { providerID, modelID }`. Assistant messages don't. The `buildMessage` helper handles this, but if you construct manually, include it.

3. **`as WithParts["info"]` cast.** The SDK `Message` type is complex. All tests cast the `info` object: `info: { ... } as WithParts["info"]`. This is normal.

4. **`Date.now` mocking leaks.** If you mock `Date.now`, always restore it in a `finally` block (see `hooks-permission.test.ts`).

5. **Session ID uniqueness.** Tests that create compress tool calls or persist state should use unique session IDs to avoid cross-test pollution: `` `ses_test_${Date.now()}` ``.
