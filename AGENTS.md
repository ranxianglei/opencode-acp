# opencode-acp Development Specification

> **This document is the highest-priority specification for this project. All developers (including AI Agents) MUST comply unconditionally.**

---

## 1. Project Overview

### 1.1 What Is ACP

**Active Context Pruning (ACP)** is an [OpenCode](https://opencode.ai) plugin that implements model-driven context management. Instead of passively truncating context at a hard limit, ACP exposes a `compress` tool to the AI model, letting it decide **when** and **what** to compress into high-fidelity summaries.

ACP is a hardened fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning) with **39 bug fixes**, including state persistence, token reporting, GC deactivation, 268x logger speedup, auto-recovery for reversed boundaries, and hard-exclusion of protected tools from compression ranges.

### 1.2 Tech Stack

| Category           | Technology                                                   |
| ------------------ | ------------------------------------------------------------ |
| Language           | TypeScript (strict, ESM)                                     |
| Runtime            | Node.js                                                      |
| Build              | `tsup` (bundling) + `tsc --emitDeclarationOnly` (types)      |
| Test Runner        | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Package Manager    | npm                                                          |
| Linting/Formatting | Prettier                                                     |
| Plugin SDK         | `@opencode-ai/plugin` >=1.4.3, `@opencode-ai/sdk` >=1.4.3    |
| Tokenizer          | `@anthropic-ai/tokenizer`                                    |
| Config Parsing     | `jsonc-parser`                                               |
| Validation         | `zod`                                                        |

### 1.3 Repository Info

| Field           | Value                                       |
| --------------- | ------------------------------------------- |
| npm package     | `opencode-acp`                              |
| Current version | 1.10.0                                      |
| GitHub          | https://github.com/ranxianglei/opencode-acp |
| License         | AGPL-3.0-or-later                           |
| Author          | ranxianglei                                 |

---

## 2. Architecture

### 2.1 Module Map

```
opencode-acp/
├── index.ts                          # Plugin entry point — wires hooks, tools, commands, config
├── lib/
│   ├── hooks.ts                      # Plugin hook handlers (system prompt, message transform, command, event, text-complete)
│   ├── config.ts                     # Three-layer config: global → config-dir → project, with DCP migration
│   ├── logger.ts                     # Structured logging (logs/acp/)
│   ├── auth.ts                       # Plugin authentication
│   ├── token-utils.ts                # Token counting utilities
│   ├── message-ids.ts                # Message ID mapping (raw ↔ mNNNNNN refs)
│   ├── compress-permission.ts        # Permission management for compress tool
│   ├── protected-patterns.ts         # File pattern protection logic
│   ├── host-permissions.ts           # Host-based permission system
│   │
│   ├── compress/                     # Compression subsystem
│   │   ├── pipeline.ts               # Shared prepare/finalize pipeline for both modes
│   │   ├── range.ts                  # Range-mode compress tool (contiguous spans → block summaries)
│   │   ├── message.ts                # Message-mode compress tool (individual message summaries)
│   │   ├── search.ts                 # Boundary resolution: maps IDs → message indices
│   │   ├── state.ts                  # Block allocation, state mutation, wrapping
│   │   ├── message-utils.ts          # Message-level utilities for compression
│   │   ├── protected-content.ts      # Protected content injection into summaries
│   │   ├── range-utils.ts            # Range-level utility functions
│   │   ├── timing.ts                 # Compression timing tracking
│   │   ├── types.ts                  # Shared type definitions (ToolContext, BoundaryReference, etc.)
│   │   └── index.ts                  # Barrel export
│   │
│   ├── messages/                     # Message processing pipeline
│   │   ├── inject/
│   │   │   ├── inject.ts             # Nudge injection (context-limit, turn, iteration) + message ID injection
│   │   │   └── utils.ts              # Anchor management, context usage calculation, budget computation
│   │   ├── prune.ts                  # Replace compressed ranges with summaries, strip tool outputs
│   │   ├── sync.ts                   # Sync compression blocks with actual messages (deactivate orphans)
│   │   ├── priority.ts               # Message priority computation
│   │   ├── query.ts                  # Message query utilities
│   │   ├── shape.ts                  # Message shape analysis
│   │   ├── reasoning-strip.ts        # Strip reasoning tokens from messages
│   │   ├── utils.ts                  # General message utilities
│   │   └── index.ts                  # Barrel export
│   │
│   ├── prompts/                      # Prompt system
│   │   ├── index.ts                  # System prompt renderer (base + extensions)
│   │   ├── store.ts                  # 6 editable prompts, file-based overrides at 3 levels
│   │   ├── system.ts                 # Base system prompt template
│   │   ├── compress-message.ts       # Message-mode compress prompt
│   │   ├── compress-range.ts         # Range-mode compress prompt
│   │   ├── context-limit-nudge.ts    # Context limit nudge template
│   │   ├── turn-nudge.ts             # Turn nudge template
│   │   ├── iteration-nudge.ts        # Iteration nudge template
│   │   └── extensions/
│   │       └── nudge.ts              # Block aging warnings + message priority guidance
│   │
│   ├── state/                        # State management
│   │   ├── state.ts                  # SessionState creation, session change detection
│   │   ├── persistence.ts            # File persistence (plugin/acp/{sessionId}.json), DCP migration
│   │   ├── tool-cache.ts             # Tool result caching
│   │   ├── types.ts                  # Core types (SessionState, CompressionBlock, Prune, etc.)
│   │   ├── utils.ts                  # State utility functions
│   │   └── index.ts                  # Barrel export
│   │
│   ├── gc/
│   │   └── truncate.ts               # Age-based deactivation + old-gen summary truncation
│   │
│   ├── strategies/                   # Automatic pruning strategies
│   │   ├── deduplication.ts          # Duplicate tool call pruning (same tool + args → keep last)
│   │   ├── purge-errors.ts           # Errored tool input pruning after N turns
│   │   └── index.ts                  # Barrel export
│   │
│   ├── subagents/
│   │   └── subagent-results.ts       # Sub-agent result caching
│   │
│   ├── commands/                     # /acp slash commands
│   │   ├── index.ts                  # Command barrel (context, stats, sweep, manual, decompress, recompress, help)
│   │   ├── context.ts                # /acp context — show current context usage
│   │   ├── stats.ts                  # /acp stats — show compression statistics
│   │   ├── sweep.ts                  # /acp sweep — force full context sweep
│   │   ├── manual.ts                 # /acp manual — toggle/trigger manual mode
│   │   ├── help.ts                   # /acp help — show available commands
│   │   ├── decompress.ts             # /acp decompress — restore compressed content
│   │   ├── recompress.ts             # /acp recompress — re-run compression
│   │   └── compression-targets.ts    # Target selection for manual compression
│   │
│   ├── ui/
│   │   ├── notification.ts           # Compression notification builder (chat/toast, minimal/detailed)
│   │   └── utils.ts                  # UI formatting utilities
│   │
│   └── update.ts                     # Auto-update check and notification
│
├── devlog/                           # Development iteration logs (templates + per-iteration entries)
│   ├── README.md                     # Usage guide and naming conventions
│   ├── REQ.template.md               # Requirement template
│   ├── WORKLOG.template.md           # Worklog template
│   ├── DESIGN.template.md            # Design document template
│   └── YYYY-MM-DD_short-title/       # One folder per iteration (REQ.md + WORKLOG.md minimum)
│
├── scripts/                          # Utility scripts
│   ├── print.ts                      # Print DCP info
│   ├── verify-package.mjs            # Package verification before publish
│   ├── README.md                     # Scripts documentation
│   └── ...                           # CLI tools for session inspection
│
├── tests/                            # Test files — 591 tests across 45 files
├── lib/config-validation.ts          # Pure validation logic (extracted from config.ts for testability)
├── dcp.schema.json                   # JSON schema for config validation
├── tsconfig.json                     # TypeScript config
├── tsup.config.ts                    # Build config
└── package.json                      # Package manifest
```

### 2.2 Core Data Flow

```
OpenCode Session
    │
    ▼
index.ts (Plugin Entry — registers hooks + tools)
    │
    ├─► System Prompt Hook (experimental.chat.system.transform)
    │       └─► prompts/index.ts → renderSystemPrompt()
    │               base prompt + extensions (protected tools, manual mode, subagent mode)
    │
    ├─► Message Transform Hook (experimental.chat.messages.transform) ← runs EVERY LLM call
    │       │
    │       ├─► checkSession() → state init, load persisted state
    │       ├─► stripHallucinations() → remove stale mNNNNN refs from model output
    │       ├─► assignMessageRefs() → bidirectional map: raw message IDs ↔ mNNNNN refs
    │       ├─► syncCompressionBlocks() → deactivate orphaned blocks (messages deleted externally)
    │       ├─► runMajorGC() → age-based block deactivation + truncate oversized summaries
    │       ├─► prune() → replace compressed ranges with summary blocks in messages
    │       ├─► injectCompressNudges() → add context-limit / turn / iteration nudges
    │       │       └─► includes block aging guidance (only when context usage > 50%)
    │       ├─► injectMessageIds() → tag every message with mNNNNN ref (or BLOCKED)
    │       ├─► applyAnchoredNudges() → render nudge text into actual messages
    │       └─► stripStaleMetadata() → clean up removed messages' metadata
    │
    ├─► Command Hook (command.execute.before)
    │       └─► /acp {context|stats|sweep|manual|decompress|recompress|help}
    │           (also accepts /dcp for backward compatibility)
    │
    ├─► Event Hook (event)
    │       └─► Track compress tool start/complete → attach duration to blocks
    │
    ├─► Text Complete Hook (experimental.text.complete)
    │       └─► Strip hallucinated mNNNNN/bN refs from completions
    │
    └─► Compress Tool (registered as "compress")
            │
            ├─► prepareSession() → permission check, fetch messages, init state
            │       ├─► deduplicate() → mark duplicate tool calls as pruned
            │       └─► purgeErrors() → remove errored tool inputs
            │
            ├─► [range mode] resolve ranges → map startId/endId to message indices
            │       ├─► Auto-swap reversed boundaries (Bug 34 fix)
            │       ├─► Inject nested block placeholders into summaries
            │       └─► Append protected content (user msgs, tags, tool outputs)
            │
            ├─► [message mode] resolve individual messages
            │
            ├─► applyCompressionState() → allocate block/run IDs, deactivate consumed blocks
            │       ├─► Create CompressionBlock (generation: young → old)
            │       ├─► Update byMessageId index
            │       └─→ Track newly compressed tokens
            │
            └─► finalizeSession() → save state, send notification
```

### 2.3 Key Concepts

#### Compression Blocks

When the model calls `compress`, one or more `CompressionBlock` objects are created:

- Each block has a `blockId` (bN) and `runId` for tracking
- Blocks track which messages/tools they cover (`directMessageIds`, `effectiveMessageIds`)
- Blocks can **nest** (newer compressions can consume older blocks)
- Blocks have a **generation**: `young` (newly created) → `old` (promoted after `promotionThreshold` survivals)
- Old-gen blocks can be **truncated** by GC if their summaries exceed `maxOldGenSummaryLength`
- Blocks track `survivedCount` — incremented each message-transform hook run

#### Message IDs

ACP maintains a bidirectional mapping:

- **Raw IDs**: OpenCode's internal message IDs (UUIDs)
- **Refs**: Short human-readable IDs (`m00001`, `m00002`, ...) shown to the model (5-digit zero-padded, max 99999)
- The model uses refs in `compress` tool calls (`startId: "m00005"`, `endId: "m00012"`)
- Block IDs use format `b0`, `b1`, etc.
- Protected messages get `BLOCKED` ref to prevent compression
- **Backward compat**: Old 4-digit refs (pre-1.1.0) are auto-migrated to 5-digit on state load

#### Session State

`SessionState` holds per-session runtime data:

- `prune` — compression state (blocks, message pruning map, active blocks)
- `nudges` — anchor tracking for context-limit, turn, and iteration nudges
- `stats` — token accounting
- `messageIds` — raw ↔ ref mapping
- `compressionTiming` — tool execution duration tracking
- `toolParameters` — tool call parameter cache
- `manualMode` — manual compress mode state

State is persisted to `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`.

### 2.4 Configuration System

Three-layer config merging (later layers override earlier):

```
1. Global:     ~/.config/opencode/acp.jsonc    (fallback: dcp.jsonc)
2. Config dir: $OPENCODE_CONFIG_DIR/acp.jsonc  (fallback: dcp.jsonc)
3. Project:    .opencode/acp.jsonc             (fallback: dcp.jsonc)
```

Auto-migration: if `acp.jsonc` doesn't exist but `dcp.jsonc` does, automatically copies.

#### Default Configuration

```typescript
{
    enabled: true,
    autoUpdate: true,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: { enabled: true, protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit", "write", "edit"] },
    manualMode: { enabled: false, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    experimental: { allowSubAgents: false, customPrompts: false },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: true,
        summaryBuffer: true,
        maxContextLimit: "55%",           // percentage of model context limit
        minContextLimit: "45%",           // percentage of model context limit
        nudgeFrequency: 5,               // nudges every N turns
        iterationNudgeThreshold: 15,     // nudge after N messages since last user message
        nudgeForce: "soft",              // "strong" | "soft"
        protectedTools: ["task", "skill", "todowrite", "todoread"],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
    },
    gc: {
        algorithm: "truncate",
        promotionThreshold: 5,           // young → old after this many survivals
        maxBlockAge: 15,                 // deactivate block after this many survivals
        maxOldGenSummaryLength: 3000,    // truncate old-gen summaries exceeding this (chars)
        majorGcThresholdPercent: "100%", // run major GC when usage exceeds this
    },
}
```

### 2.5 Storage Paths

| What              | ACP Path                          | Legacy DCP Path | Migration                 |
| ----------------- | --------------------------------- | --------------- | ------------------------- |
| State persistence | `plugin/acp/{sessionId}.json`     | `plugin/dcp/`   | Auto-copy on first access |
| Config            | `~/.config/opencode/acp.jsonc`    | `dcp.jsonc`     | Auto-copy on first access |
| Prompt overrides  | `~/.config/opencode/acp-prompts/` | `dcp-prompts/`  | Auto-copy on first access |
| Debug logs        | `logs/acp/`                       | `logs/dcp/`     | Path change only          |

Base storage: `~/.local/share/opencode/storage/`

### 2.6 Internal vs External Naming

ACP maintains **backward compatibility** with DCP in internal code:

| Scope                                                                                                                 | Naming Convention                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **User-visible** (commands, UI, notifications, docs, config files, storage paths)                                     | `ACP`, `acp`                     |
| **Internal code** (XML tags, regex variables, schema URLs)                                                            | `dcp` — kept for backward compat |
| **Examples**: `dcp-message-id` tag, `dcp-system-reminder` tag, `DCP_BLOCK_ID_TAG_REGEX`, `dcp.schema.json` schema URL |

**Rule**: Never change internal `dcp` naming without a migration plan. These tags appear in persisted state and LLM interactions.

---

## 3. Development Standards

### 3.1 Build Commands

```bash
npm run clean          # Remove dist/
npm run build          # Clean + tsup + tsc --emitDeclarationOnly
npm run typecheck      # TypeScript type checking (no emit)
npm run test           # Run tests: node --import tsx --test tests/*.test.ts
npm run format         # Format with Prettier
npm run format:check   # Check formatting
npm run verify:package # Verify package contents before publish
npm run check:package  # Build + verify
```

### 3.2 Build Output

- `dist/` — bundled JavaScript (ESM)
- `dist/*.d.ts` — TypeScript declaration files
- Published files (per `files` field in package.json): `dist/`, `README.md`, `LICENSE`

### 3.3 Testing

**Test runner**: `node --import tsx --test tests/*.test.ts`

**Test directory**: Flat `tests/` structure — all test files in `tests/*.test.ts`. No subdirectories.
The project has ~70 source files under `lib/` and 45 test files; flat structure is sufficient.

CI is configured via GitHub Actions (PR #2): typecheck + test + build on Node 22/24 matrix.

**Baseline**: Tag `v1.0.1-test-baseline` — 95 tests, initial state before ACP test fixes.

**Test categories** (by naming convention, all in `tests/`):

| Category          | Files                                                                                                                                                                              | Tests | Description                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------ |
| **Baseline**      | `hooks-permission.test.ts`, `compress-message.test.ts`, `compress-range.test.ts`, `message-priority.test.ts`, `token-counting.test.ts`, `context-limits.test.ts`, `update.test.ts` | 95    | Original DCP tests, adapted for ACP  |
| **Tier 1 (pure)** | `config-validation.test.ts`, `priority-classify.test.ts`, `shape.test.ts`, `query-pure.test.ts`, `gc-truncate-pure.test.ts`, `state-utils-pure.test.ts`                            | 83    | Pure function tests, no side effects |
| **Tier 2 (mock)** | `query-mock.test.ts`, `gc-truncate-mock.test.ts`, `strategies-dedup.test.ts`, `strategies-purge-errors.test.ts`                                                                    | 68    | Mock-data unit tests                 |
| **Functional**    | `compress-search.test.ts`, `compress-state.test.ts`, `message-ids.test.ts`                                                                                                         | 77    | Compress pipeline with mock data     |
| **E2E**           | `e2e-message-transform.test.ts`, `e2e-blocks-nudges.test.ts`                                                                                                                       | 21    | Full message-transform pipeline      |

**Total: 591 tests, 0 failures** (as of v1.10.0)

**Test review requirement**: All new and modified test files MUST undergo independent review by at least 2 separate agents before commit. See Section 5.4.

**Coverage gaps** (modules still without dedicated tests):

- `state/persistence.ts` — state persistence, DCP migration
- `messages/prune.ts` — prune replacement logic
- `messages/sync.ts` — block synchronization
- `messages/inject/inject.ts` — nudge injection
- `commands/*.ts` — slash command handlers
- `ui/notification.ts` — notification builder

### 3.4 Deployment (Local Testing)

**One command** — build + deploy to the local opencode plugin cache:

```bash
./scripts/dev-deploy.sh           # Type check + build + deploy
./scripts/dev-deploy.sh --check   # Tests + type check + build + deploy
./scripts/dev-deploy.sh --no-build # Deploy existing dist/ only
```

opencode resolves `opencode-acp@latest` to:

```
~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/
```

**⚠️ Restart opencode after deploying** — the running process caches the module in memory. To pick up changes, kill the opencode process and restart.

**Verify the deployed bundle has your changes:**

```bash
grep -c 'your-feature-name' ~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/dist/index.js
```

**Common mistake**: Deploying to `~/.cache/opencode/node_modules/opencode-acp/` (wrong path — that's the old resolution path, not where `@latest` resolves).

**ACP debug logs** (for verifying injection behavior):

```
~/.config/opencode/logs/acp/context/<session_id>/<timestamp>.json   # per-request message snapshots
~/.config/opencode/logs/acp/daily/<date>.log                        # session load/save events
```

### 3.5 npm Publishing

```bash
# Pre-publish checks (runs build + verify)
npm run check:package

# Publish (uses Automation token for 2FA bypass)
npm publish
```

**Important**: The `.git/config` contains a GitHub OAuth token in the remote URL. Ensure it's not included in the npm package (the `files` field prevents this).

---

## 4. Code Change Guidelines

### 4.1 Module Dependencies

**Dependency graph** (simplified):

```
config.ts ← (consumed by everything)
    ↑
state/state.ts ← state/persistence.ts
    ↑
hooks.ts ← messages/inject, messages/prune, messages/sync, gc, prompts, state
    ↑
compress/pipeline.ts ← strategies/, state, config
    ↑
compress/range.ts ← compress/search, compress/state, compress/pipeline
compress/message.ts ← compress/search, compress/state, compress/pipeline
```

**Rules**:

- `config.ts` has no internal dependencies (leaf node)
- `state/` depends only on `config` and SDK types
- `hooks.ts` is the orchestrator — depends on most other modules
- `compress/` subsystem is self-contained; external code uses it through `pipeline.ts` or the tool functions

### 4.2 Key File Sizes (Complexity Indicators)

| File                            | Lines | Notes                                                   |
| ------------------------------- | ----- | ------------------------------------------------------- |
| `lib/config.ts`                 | ~1125 | Largest file — validation, merging, migration, defaults |
| `lib/hooks.ts`                  | ~700  | Core pipeline orchestration                             |
| `lib/compress/range.ts`         | ~600  | Range-mode compression logic                            |
| `lib/messages/inject/inject.ts` | ~500  | Nudge system brain                                      |
| `lib/prompts/store.ts`          | ~478  | Prompt management                                       |
| `lib/compress/search.ts`        | ~450  | Boundary resolution                                     |

### 4.3 Common Patterns

**State access pattern**: All modules receive `PluginConfig`, `SessionState`, and `Logger` through function parameters or a `ToolContext` object. No global singletons.

**Message transform pipeline**: Sequential steps in `hooks.ts`. Order matters — each step depends on the output of previous steps. Do NOT reorder without understanding dependencies.

**ID resolution**: The model uses short refs (`m0`, `b3`). These must be resolved to raw UUIDs via `messageIds.byRef` before any operation. Search (`compress/search.ts`) handles boundary resolution.

**Protected content**: Tools in `protectedTools` arrays and files matching `protectedFilePatterns` are never pruned. Their content is injected into compression summaries.

### 4.4 Bug Fix History (Key Fixes)

For reference when modifying code — these bugs were real and the fixes are load-bearing:

| Bug                | Fix Location                               | What It Fixed                                                                                                                                                                                      |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug 39             | `compress/range.ts`, `compress/message.ts` | Hard-exclude protected tool messages (skill/task/todowrite) from compression ranges — they survive intact in visible context instead of being soft-appended to summaries (which GC could truncate) |
| Bug 35             | `nudge.ts`                                 | Aging warning only shows when context usage > 50% (was showing at 20-30%)                                                                                                                          |
| Bug 34             | `search.ts`                                | Auto-swap reversed compress boundaries (model gave endId < startId)                                                                                                                                |
| State persistence  | `persistence.ts`                           | State survives restart (was lost before)                                                                                                                                                           |
| Token reporting    | `token-utils.ts`                           | Returns actual token counts (was returning 0)                                                                                                                                                      |
| GC deactivation    | `gc/truncate.ts`                           | Age-based block deactivation (blocks were never deactivated)                                                                                                                                       |
| Logger speedup     | `logger.ts`                                | 268x faster tokenization (was using sync API)                                                                                                                                                      |
| Summary resolution | `compress/range.ts`                        | Block placeholder injection for nested compressions                                                                                                                                                |
| Config migration   | `config.ts`                                | Auto-migrate dcp.jsonc → acp.jsonc at getConfig() entry point                                                                                                                                      |

---

## 5. Contributing

### 5.1 Before Making Changes

1. Run `npm run typecheck` to ensure no type errors
2. Run `npm run format:check` to ensure formatting is consistent
3. Understand the module dependency graph (Section 4.1)
4. Check if the change affects backward compatibility (Section 2.6)

### 5.1.1 Development Workflow

All changes MUST follow this workflow:

1. Create a feature branch from `master` (naming: `YYYY-MM-DD_short-title`)
2. Create devlog entry: `devlog/{YYYY-MM-DD_short-title}/` with `REQ.md` (see Section 5.1.2)
3. Implement changes
4. Ensure `npm run build` and `npm run typecheck` pass
5. Ensure all tests pass: `npm run test`
6. Commit with descriptive messages (include devlog files)
7. Push branch and create a GitHub PR
8. Obtain **dual-agent review** (Sections 5.3 + 5.4) on the PR
9. **PR merge requires explicit human confirmation** — AI agents MUST NOT autonomously merge PRs or push to master. Wait for the user to explicitly say "merge" or "approve merge".

### 5.1.1.1 Git Safety Rules (MANDATORY)

| Rule                                                                    | Enforcement                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **NEVER force-push to `master`**                                        | Under no circumstances. Not for reverts, not for fixes, not for "quick corrections". If master needs changing, create a PR. |
| **NEVER merge PRs without explicit human authorization**                | "merge" or "approve merge" must come from a human comment. Agent reviews passing ≠ authorization to merge.                  |
| **NEVER remove and re-apply GitHub branch protection to force changes** | This is a circumvention of the merge policy. If protection blocks a push, the correct response is to create a PR.           |
| **NEVER delete branches or tags without human confirmation**            | Preserve work for review.                                                                                                   |

### 5.1.2 Devlog Requirement (MANDATORY)

Every PR MUST have a corresponding devlog entry in `devlog/{YYYY-MM-DD_short-title}/`.

**Rules:**

- The folder name MUST match the branch name
- `REQ.md` and `WORKLOG.md` are the required minimum
- `DESIGN.md` is required for any change affecting architecture, data flow, or module boundaries
- `REQ.md` should be filled **BEFORE** implementation (functions as a ticket)
- `WORKLOG.md` should be updated **DURING** and **AFTER** implementation
- Devlog files are committed alongside code changes — not as a separate afterthought

See `devlog/README.md` for templates and naming conventions.

### 5.2 After Making Changes

1. `npm run build` must pass
2. `npm run typecheck` must pass
3. Run relevant tests
4. Deploy locally and test in opencode
5. Update version in `package.json` before publishing

### 5.3 Code Review (MANDATORY)

All source code changes (files under `lib/`) MUST undergo independent review by **at least 2 separate agents** before merge. This applies to:

- New modules added to `lib/`
- Modified source files
- Changes to shared types, interfaces, or exports

**Review checklist:**

| Category                   | What to Check                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| **Correctness**            | Logic matches intent, no off-by-one errors, edge cases handled                               |
| **Backward compatibility** | No breaking changes to persisted state format, exported APIs, or internal tags (Section 2.6) |
| **Performance**            | No unnecessary CPU/memory overhead, no O(n²) where O(n) suffices                             |
| **Type safety**            | No `as any`, no `@ts-ignore`, no type assertion hacks                                        |
| **State integrity**        | State mutations are safe, no lost data on save/load cycle                                    |

### 5.4 Release Workflow (Automated via CI)

Releases are **fully automated through GitHub Actions**. The workflow is: create a release PR → merge → CI auto-tags, builds, tests, and publishes to npm. No manual `npm publish` or `git tag` needed.

#### 5.4.1 CI Workflows

Two GitHub Actions workflows enforce AGENTS.md standards and automate releases:

**`pr-checks.yml`** — runs on every PR to master:

| Check       | What it validates                                                                                                  | Script                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Branch name | Matches `YYYY-MM-DD_short-title` (regex: `^\d{4}-\d{2}-\d{2}_[a-z0-9.-]+$`)                                        | `scripts/ci/check-pr.sh` |
| Devlog      | `devlog/{branch-name}/REQ.md` and `WORKLOG.md` exist                                                               | same                     |
| Changelog   | If `package.json` version changed, `README.md` and `README.zh-CN.md` must be modified and contain `### v{VERSION}` | same                     |

**`release.yml`** — triggers on push to master (PR merge):

1. Checks if the merge commit came from a release branch (`YYYY-MM-DD_release-v*`)
2. If yes, reads `package.json` version and creates `v{VERSION}` tag
3. Runs `npm ci` → `npm run check:package` → `npm test`
4. Publishes to npm registry (uses `NPM_TOKEN` secret)
5. Creates GitHub Release with auto-generated notes

**Why not separate tag-triggered publish?** GitHub Actions does not allow workflows pushed by `GITHUB_TOKEN` to trigger other workflows. A separate `auto-tag.yml` + tag-triggered `release.yml` chain does not work — the tag push from `auto-tag.yml` won't fire `release.yml`. The unified workflow solves this by doing everything in one job.

Can also be triggered manually via `workflow_dispatch` with `force: true` to publish outside a release branch merge.

#### 5.4.2 Release Process (Step-by-Step)

**Step 1: Create a release branch**

```bash
git checkout master
git pull origin master
git checkout -b YYYY-MM-DD_release-v{VERSION}
```

The branch name MUST match `YYYY-MM-DD_release-v{VERSION}` for auto-tagging to work (e.g., `2026-07-11_release-v1.11.2`).

**Step 2: Bump version + update changelog + devlog**

```bash
# Edit package.json — bump version
# Edit README.md — add changelog entry under "## Changelog"
# Edit README.zh-CN.md — add changelog entry under "## 更新日志"
# Create devlog/YYYY-MM-DD_release-v{VERSION}/REQ.md + WORKLOG.md
```

Changelog format:

```markdown
### v{VERSION} — Title (PR #NNN)

**Problem**: What was wrong.
**Fix**: What changed.
Files: `path/to/file.ts`. Tests: `tests/file.test.ts`.
```

**Step 3: Verify locally, commit, push, create PR**

```bash
# Verify CI checks pass locally
./scripts/ci/check-pr.sh YYYY-MM-DD_release-v{VERSION} origin/master

# Commit
git add -A
git commit -m "release: v{VERSION} — title"
git push origin YYYY-MM-DD_release-v{VERSION}

# Create PR (CI will run pr-checks.yml + ci.yml)
gh pr create --title "release: v{VERSION} — title" --body "..."
```

**Step 4: Merge PR (requires human confirmation)**

Wait for CI to pass (`pr-validation`, `test`, `build`), then a human merges the PR.

**Step 5: Auto-publish (fully automated)**

Merging the PR triggers `release.yml` automatically — no manual action needed:

1. Push to master → `release.yml` detects release branch merge (`YYYY-MM-DD_release-v*`)
2. Creates `v{VERSION}` tag, builds, tests, publishes to npm, creates GitHub Release

All in one workflow — no chained workflows (GitHub Actions limitation: `GITHUB_TOKEN` cannot trigger other workflows).

**Step 6: Verify**

```bash
# Check npm registry
npm view opencode-acp version

# Check GitHub Release
gh release view v{VERSION} --repo ranxianglei/opencode-acp
```

#### 5.4.3 Prerequisites

- **`NPM_TOKEN` secret** must be set in GitHub repo settings (Settings → Secrets → Actions). Create an "Automation" type token at https://www.npmjs.com/settings/ranxianglei/tokens.
- **GitHub branch protection** on `master` must require `pr-validation` check to pass before merge.
- **Release branch naming** must follow `YYYY-MM-DD_release-v{VERSION}` for auto-tagging to trigger.

#### 5.4.4 Manual Publish (Legacy Fallback)

If CI is down or `NPM_TOKEN` is misconfigured, publish manually as a fallback:

```bash
# 0. Ensure clean state on master
git checkout master && git pull origin master
git status --porcelain  # MUST be empty

# 1. Build + verify
npm run check:package

# 2. Privacy audit
npm pack --dry-run 2>&1
npm pack && tar -tf opencode-acp-*.tgz | grep -iE '\.env|secret|credential|token|key|\.pem|\.key'
rm opencode-acp-*.tgz

# 3. Tag + publish
git tag -a "v{VERSION}" -m "release v{VERSION}"
git push origin "v{VERSION}"
npm publish

# 4. Verify
npm view opencode-acp version
```

Only use this as a fallback. The automated workflow (Section 5.4.2) is the standard release process.

### 5.5 Commit Convention

Use descriptive commit messages. Historical examples:

- `fix: aging warning only shows when context usage > 50%`
- `feat: /dcp → /acp command rename with backward compat`
- `chore: bump version to 1.0.1`
- `fix: config migration moved to getConfig() entry point`

### 5.6 Test Review (MANDATORY)

All new and modified test files MUST undergo independent review by **at least 2 separate agents** before merge (same requirement as Section 5.3 code review). This requirement applies to:

- New test files added to `tests/`
- Modified test files (changed test logic, not just test names)
- Changes to test utilities or factories that affect test correctness

**Review checklist:**

| Category                  | What to Check                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import correctness**    | Tests import from actual source files, not local reimplementations. If a source module has untestable runtime dependencies, extract pure logic into a separate importable module. |
| **Test name fidelity**    | Test name accurately describes what the test asserts. A test named "returns true" must assert `true`, not `false`.                                                                |
| **Config completeness**   | `buildConfig()` factory includes ALL required config fields (including `gc`), matching the `PluginConfig` type.                                                                   |
| **Input validity**        | Test inputs actually exercise the code path described in the test name. A "dcp tag stripping" test must contain actual dcp tags.                                                  |
| **No tautological tests** | Tests must assert meaningful behavior, not trivially true conditions (e.g., `assert.equal(x, x)`).                                                                                |

**Anti-patterns to flag:**

- Tests that reimplement source logic locally instead of importing from source
- `buildConfig()` missing fields that other test files include
- Test names that contradict their assertions
- Tests whose inputs don't match what the test name describes
