# DESIGN: ACP v2 Architecture — Clean-Room Rewrite

> **Status**: v2 (revised after dual-agent review)
> **Date**: 2026-06-27
> **Author**: awork (bot)
> **Review**: Two explore agents reviewed v1; 5 BLOCKER + 4 MEDIUM issues found and addressed in this revision
> **Goal**: Design the target architecture for the MIT-licensed clean-room rewrite of ACP

---

## 1. Motivation

The current ACP codebase is a hardened fork of DCP (AGPL-3.0). To relicense to MIT, the AGPL-derived code must be replaced with independently-authored implementations. This rewrite also fixes architectural debt accumulated during the fork's rapid bug-fix phase (34 fixes, 60 commits).

### 1.1 Legal Constraint

All code in `lib/` that derives from the original DCP is AGPL-bound (§5 copyleft + §13 network disclosure). The clean-room rewrite must:
- Not copy, transform, or adapt any AGPL-derived code
- Be authored based solely on the **behavioral specification** (473+ tests + AGENTS.md data flow)
- Carry MIT license from inception

### 1.2 Architectural Debt

| Problem | Metric | Impact |
|---------|--------|--------|
| hooks.ts god module | 507 LOC, 23-step pipeline in one function | Untestable in isolation, change amplification |
| config.ts + config-validation.ts monolith | 1761 LOC combined | Unclear responsibilities, hard to extend |
| Mutable state by reference | All functions mutate SessionState in place | Data flow invisible, race-condition risk |
| Tangled module dependencies | hooks.ts imports from 15+ modules | Circular coupling, fragile structure |
| Mixed responsibilities | prune.ts both filters ranges AND prunes tool outputs | Module boundaries don't match domain concepts |

---

## 2. Design Principles

1. **Single Responsibility** — each module has exactly one reason to change
2. **Centralized Mutation Surface** — all state mutations go through dedicated mutation functions; queries are read-only
3. **Composable Pipeline** — transform stages are pluggable, not hardcoded
4. **Dependency Inversion** — modules depend on interfaces, not implementations
5. **Test-First** — every module is testable in isolation without mocking the world
6. **Behavioral Equivalence** — new code must pass the same behavioral tests as old code

---

## 3. Target Module Structure

```
lib-v2/
├── index.ts                          # Plugin entry — wiring only, no logic
│
├── plugin/                           # OpenCode hook adapters (thin)
│   ├── hooks.ts                      # Hook registration (createSystemPromptHandler, etc.)
│   ├── system-prompt.ts              # System prompt rendering + injection
│   ├── message-transform.ts          # Pipeline coordinator — guard + stage runner
│   ├── command-router.ts             # /acp command dispatch
│   ├── event-tracker.ts              # Compression timing event tracking
│   ├── text-sanitizer.ts             # Strip hallucinated refs from completions
│   └── update-checker.ts             # Auto-update check at plugin init
│
├── config/                           # Configuration system
│   ├── types.ts                      # PluginConfig, CompressConfig, GCConfig, etc.
│   ├── defaults.ts                   # Default values (single source of truth)
│   ├── schema.ts                     # Zod validation schema (absorbs config-validation.ts)
│   ├── parser.ts                     # JSONC file reading + parsing
│   ├── merger.ts                     # Three-layer merge (global → config-dir → project)
│   ├── migrator.ts                   # DCP → ACP config migration
│   └── index.ts                      # getConfig() — orchestrates parser → schema → merger → migrator
│
├── state/                            # Session state management
│   ├── types.ts                      # SessionState, CompressionBlock, PruneEntry, etc.
│   ├── factory.ts                    # createSessionState() — clean initialization
│   ├── persistence.ts                # save() / load() — JSON round-trip + Map serialization
│   ├── mutations/                    # All state mutations (centralized, auditable)
│   │   ├── blocks.ts                 # allocateBlock, deactivateBlock, consumeBlocks
│   │   ├── prune-map.ts              # markPruned, unmarkPruned, updateActiveBlockIds
│   │   └── gc.ts                     # ageBlocks, promoteGeneration, truncateSummary
│   └── queries.ts                    # Read-only queries (isCompacted, getActiveBlocks, etc.)
│
├── pipeline/                         # Message transform pipeline (composable)
│   ├── types.ts                      # PipelineStage interface, PipelineContext
│   ├── compose.ts                    # runPipeline(stages, context) — executor
│   └── stages/                       # Each stage = one focused transformation
│       ├── 00-guard-internal-agent.ts # Bug 37: skip title/summary/compaction agents
│       ├── 01-check-session.ts        # Session init / change detection
│       ├── 02-sync-permissions.ts     # Host permission snapshot sync
│       ├── 03-strip-hallucinations.ts # Remove stale mNNNNN refs from model output
│       ├── 04-cache-system-tokens.ts  # Cache system prompt token count for budget math
│       ├── 05-assign-refs.ts          # Bidirectional mNNNNN ↔ raw ID mapping
│       ├── 06-sync-blocks.ts          # Deactivate orphaned compression blocks
│       ├── 07-sync-tool-cache.ts      # Update cached tool parameters
│       ├── 08-build-tool-id-list.ts   # Ordered tool ID list for token accounting
│       ├── 09-major-gc.ts             # Age-based deactivation + summary truncation
│       ├── 10-batch-cleanup.ts        # Merge-cleanup for marked blocks (gc/merge)
│       ├── 11-prune.ts                # Replace compressed ranges with summaries
│       ├── 12-reassign-refs.ts        # Assign refs to synthetic messages from prune
│       ├── 13-inject-subagent.ts      # Sub-agent result injection
│       ├── 14-compute-priority.ts     # Build priority map for messages
│       ├── 15-reload-prompts.ts       # Reload prompt overrides from disk
│       ├── 16-inject-nudges.ts        # Context-limit / turn / iteration nudges
│       ├── 17-inject-ids.ts           # Tag messages with mNNNNN refs
│       ├── 18-apply-manual-trigger.ts # Process pending manual compress (state-only)
│       ├── 19-strip-metadata.ts       # Remove stale provider metadata
│       └── 20-persist-context.ts      # Save context snapshot for debugging
│
├── compress/                         # Compression subsystem (ALL tools)
│   ├── tools/                        # Model-facing tool definitions
│   │   ├── compress.ts               # compress tool (range + message modes)
│   │   ├── decompress.ts             # decompress tool [Class B: migrate]
│   │   ├── decompress-logic.ts       # decompress core logic [Class B: migrate]
│   │   ├── mark-block.ts             # mark_block + unmark_block tools [Class B: migrate]
│   │   └── batch.ts                  # batch cleanup trigger (if exposed as tool)
│   ├── pipeline.ts                   # prepareSession / finalizeSession (shared)
│   ├── range-mode.ts                 # Range-mode compression logic
│   ├── message-mode.ts               # Message-mode compression logic
│   ├── search.ts                     # Boundary resolution (mNNNNN → message indices)
│   └── protected-content.ts          # Protected user messages / tags / tool outputs
│
├── gc/                               # Garbage collection algorithms
│   ├── truncate.ts                   # Old-gen summary truncation algorithm
│   └── merge.ts                      # Batch merge-cleanup algorithm [Class B: migrate]
│
├── strategies/                       # Automatic pruning strategies
│   ├── deduplicate.ts                # Strategy: duplicate tool call pruning
│   └── purge-errors.ts              # Strategy: errored tool input pruning
│
├── messages/                         # Message utilities (pure functions)
│   ├── types.ts                      # Message helper types
│   ├── query.ts                      # getLastUserMessage, getMessagesInRange, etc.
│   ├── shape.ts                      # isMessageWithInfo, filterMessagesInPlace
│   ├── priority.ts                   # Message priority computation
│   └── utils.ts                      # Text part manipulation, ref stripping
│
├── prompts/                          # Prompt system
│   ├── store.ts                      # Prompt management + file overrides
│   ├── renderer.ts                   # System prompt composition (base + extensions)
│   ├── templates/                    # Static prompt templates
│   │   ├── system.ts
│   │   ├── compress-range.ts
│   │   ├── compress-message.ts
│   │   ├── context-limit-nudge.ts
│   │   ├── turn-nudge.ts
│   │   └── iteration-nudge.ts
│   └── extensions/                   # Dynamic prompt extensions
│       ├── protected-tools.ts        # List protected tools in system prompt
│       ├── tool-format.ts            # Range/message format instructions
│       ├── decompress.ts             # Decompress tool instructions
│       ├── manual-mode.ts            # Manual mode instructions
│       ├── subagent-mode.ts          # Sub-agent mode instructions
│       └── nudge-guidance.ts         # Block aging + priority guidance
│
├── commands/                         # /acp slash commands
│   ├── context.ts                    # /acp context
│   ├── stats.ts                      # /acp stats
│   ├── sweep.ts                      # /acp sweep
│   ├── manual.ts                     # /acp manual
│   ├── decompress.ts                 # /acp decompress
│   ├── recompress.ts                 # /acp recompress
│   └── help.ts                       # /acp help
│
├── permissions/                      # Permission subsystem (was scattered in v1)
│   ├── auth.ts                       # Plugin authentication [Class B: migrate]
│   ├── compress-permission.ts        # ask/allow/deny gating [Class B: migrate]
│   ├── host-permissions.ts           # Host-based permission snapshot [Class B: migrate]
│   └── protected-patterns.ts         # File glob pattern protection [Class B: migrate]
│
├── subagents/                        # Sub-agent integration
│   └── subagent-results.ts           # Sub-agent result caching [Class B: migrate]
│
├── ui/                               # User-facing output
│   └── notification.ts               # Compression notification builder
│
└── infra/                            # Cross-cutting infrastructure
    ├── logger.ts                     # Structured logging
    ├── token-counter.ts              # Token counting (tokenizer wrapper)
    └── message-refs.ts               # mNNNNN formatting/parsing (5-digit zero-padded)
```

**File count**: ~85 files (v1 has 70). The increase is from pipeline stage decomposition (21 stages) and config split (7 files). The win is **max file size**: largest v2 file ~250 LOC vs v1's 1125 LOC (config.ts).

---

## 4. Core Design Decisions

### 4.1 Pipeline Architecture (Replacing hooks.ts God Module)

**Current**: A single 73-line function in `createChatMessageTransformHandler` runs 23 sequential steps inline.

**New**: Each step becomes a `PipelineStage`. The coordinator runs them in order, with a pre-pipeline guard for internal agent requests.

```typescript
// pipeline/types.ts
interface PipelineStage {
    name: string
    run(ctx: PipelineContext): Promise<void> | void
}

interface PipelineContext {
    messages: WithParts[]
    state: SessionState
    config: PluginConfig
    logger: Logger
    client: PluginClient
    prompts: PromptStore
}
```

```typescript
// plugin/message-transform.ts
const PIPELINE_STAGES: PipelineStage[] = [
    guardInternalAgent,    // Bug 37: skip if internal agent (returns early)
    checkSession,
    syncPermissions,
    stripHallucinations,
    cacheSystemTokens,
    assignRefs,
    syncBlocks,
    syncToolCache,
    buildToolIdList,
    majorGC,
    batchCleanup,
    prune,
    reassignRefs,
    injectSubAgent,
    computePriority,
    reloadPrompts,
    injectNudges,
    injectIds,
    applyManualTrigger,    // state-only, does NOT call compress tool
    stripMetadata,
    persistContext,
]

export function createMessageTransformHandler(deps: PipelineDeps) {
    return async (_input: {}, output: { messages: WithParts[] }) => {
        const ctx = { ...deps, messages: output.messages }
        for (const stage of PIPELINE_STAGES) {
            await stage.run(ctx)
            if (ctx.shouldSkip) return  // guard stages can set this
        }
    }
}
```

**Note**: `applyManualTrigger` only mutates state (`state.manualMode`, `state.pendingManualTrigger`). It does NOT invoke the compress tool. This respects the `pipeline → compress` dependency prohibition.

### 4.2 State Management (Centralized Mutation Surface)

**Current**: Any function can mutate `state.prune.messages.blocksById`, `state.prune.tools`, etc. directly. 15+ modules mutate state.

**New**: All state mutations go through `state/mutations/` functions. Queries are read-only.

**Dual contract**: Messages are mutated in place (OpenCode owns them). State is mutated only through `state/mutations/` functions (ACP owns it).

**Persistence timing**: Pipeline stages may call `immediateSave(reason)` for mid-pipeline saves that bug fixes require (Bug 4: save after syncBlocks). A final `persistContext` stage at the end handles the regular save. Both go through `state/persistence.ts`.

### 4.3 Config System (Split Monolith)

**Current**: `config.ts` (1125 LOC) + `config-validation.ts` (636 LOC) = 1761 LOC combined.

**New**: 8 focused modules:

| Module | Responsibility | LOC est. |
|--------|---------------|----------|
| `types.ts` | Type definitions only | ~100 |
| `defaults.ts` | Default values (const object) | ~80 |
| `schema.ts` | Zod schema — absorbs config-validation.ts (636 LOC) | ~250 |
| `parser.ts` | Read JSONC files from disk | ~100 |
| `merger.ts` | Deep merge 3 config layers | ~120 |
| `migrator.ts` | DCP → ACP path migration | ~80 |
| `index.ts` | Orchestrate: parse → validate → merge → migrate | ~60 |
| **Total** | | **~790** |

### 4.4 Compress Tool Decomposition

**Current**: `compress/range.ts` (600 LOC) handles everything.

**New**: Split into focused modules. All four model-facing tools (`compress`, `decompress`, `mark_block`, `unmark_block`) are placed in `compress/tools/`.

Class B modules (decompress, decompress-logic, mark-block) are migrated with interface adaptation — they import from new `state/mutations/` instead of v1's `compress/state.ts`.

### 4.5 Dependency Rules

```
Permitted dependencies:
  plugin/*     → everything (hook adapters wire all subsystems)
  pipeline/*   → state/*, messages/*, config/*, gc/*, prompts/*, infra/*, permissions/*
  compress/*   → state/*, messages/*, config/*, prompts/*, search.ts, protected-content.ts
  commands/*   → state/*, compress/*, messages/*, config/*, prompts/*, ui/*
  gc/*         → state/* (mutations only)
  prompts/*    → config/*, messages/* (utilities only)
  state/*      → config/* (types), infra/* (logger)
  messages/*   → infra/* (token-counter for queries)
  infra/*      → (nothing — leaf modules)
  permissions/* → config/*, state/*

FORBIDDEN:
  - pipeline/* → plugin/*     (stages must not invoke hook adapters)
  - pipeline/* → commands/*   (stages must not invoke slash commands)
  - pipeline/* → compress/*   (stages don't call compress tool; see §4.1 note)
  - state/*    → pipeline/*, compress/*, plugin/*, commands/*  (state is a sink)
  - messages/* → state/*, pipeline/*, compress/*  (pure utilities)
  - infra/*    → anything except its own internals
  - prompts/*  → pipeline/*, compress/*, state/*  (render from config + static templates)
  - Circular dependencies of any kind
```

**gc/merge.ts clarification**: Lives in `gc/` but allocates blocks via `state/mutations/blocks.ts` (not `compress/`). This avoids a `gc → compress` cross-package dependency. The module imports `allocateBlock` from `state/mutations/`.

---

## 5. Data Flow (Message Transform)

```
OpenCode calls message-transform hook
    │
    ▼
plugin/message-transform.ts — guard + stage runner
    │
    ├─⓪ guard-internal-agent:  Bug 37 — skip if title/summary/compaction agent
    ├─① check-session:         Init/reset state on session change
    ├─② sync-permissions:      Host permission snapshot → compress permission state
    ├─③ strip-hallucinations:  Remove stale mNNNNN from model output
    ├─④ cache-system-tokens:   Cache system prompt token count for budget math
    ├─⑤ assign-refs:           Build raw↔ref bidirectional map
    ├─⑥ sync-blocks:           Deactivate blocks whose anchors were deleted
    ├─⑦ sync-tool-cache:       Update cached tool parameters
    ├─⑧ build-tool-id-list:    Ordered tool ID list for token accounting
    ├─⑨ major-gc:              Age-based deactivation + oversized summary truncation
    ├─⑩ batch-cleanup:         Merge blocks marked for deferred cleanup (gc/merge)
    ├─⑪ prune:                 Replace compressed ranges with summary blocks
    ├─⑫ reassign-refs:         Assign refs to synthetic messages from ⑪
    ├─⑬ inject-subagent:       Inject cached sub-agent results (if enabled)
    ├─⑭ compute-priority:      Build message priority map
    ├─⑮ reload-prompts:        Reload prompt overrides from disk
    ├─⑯ inject-nudges:         Add context-limit/turn/iteration nudges
    ├─⑳ inject-ids:            Tag messages with mNNNNN refs for model
    ├─⑲ apply-manual-trigger:  Process pending manual compress (state-only, no compress call)
    ├─⑳ strip-metadata:        Remove stale provider metadata from parts
    └─㉑ persist-context:       Save context snapshot + deferred state persistence
```

---

## 6. Key Types

### 6.1 SessionState

No structural change from v1 — the type is sound. `blockId` is `number`, `blocksById` is `Map<number, CompressionBlock>`, `activeBlockIds` is `Set<number>`. Map serialization helpers must be ported to `state/persistence.ts` (JSON doesn't natively serialize Maps).

### 6.2 CompressionBlock (Unchanged)

Preserved as-is. Well-designed, battle-tested through 34 bug fixes.

---

## 7. Migration Strategy

### 7.1 Phased Development (lib-v2/ alongside lib/)

```
Phase 2a: Foundation (~1.5 weeks)
  - config/ (8 modules including schema.ts absorbing config-validation.ts)
  - state/ (factory, types, queries, mutations/, persistence)
  - infra/ (logger, token-counter, message-refs)
  - messages/ (pure utilities)
  - permissions/ (auth, compress-permission, host-permissions, protected-patterns) [Class B]

Phase 2b: Pipeline (~1.5 weeks)
  - pipeline/ (21 stages — see §5)
  - plugin/message-transform.ts
  - Verify: isolated stage unit tests pass

Phase 2c: Compress + GC + Strategies (~1.5 weeks)
  - compress/tools/ (compress, decompress, mark-block) [decompress/mark-block: Class B]
  - compress/ (range-mode, message-mode, search, protected-content, pipeline)
  - gc/ (truncate, merge) [merge: Class B]
  - strategies/ (deduplicate, purge-errors)

Phase 2d: Integration (~2 weeks)
  - prompts/ (store, renderer, 6 templates, 6 extensions)
  - commands/ (7 commands)
  - plugin/ (all 5 hook handlers + update-checker)
  - ui/notification.ts
  - subagents/ [Class B]
  - index.ts (wiring)
  - E2E tests pass

Phase 2e: Cutover (~1.5 weeks)
  - Rewrite white-box tests for v2 module boundaries (see §7.2)
  - Run full test suite against lib-v2/
  - Deploy locally, test in opencode
  - Delete lib/, rename lib-v2/ → lib/
  - Switch LICENSE to MIT
  - Publish as v2.0.0

Total: ~8 weeks
```

### 7.2 Testing Strategy

Tests are classified into two categories:

**Behavioral tests** (black-box, portable to v2 with import changes only):
- e2e-message-transform.test.ts, e2e-blocks-nudges.test.ts
- Tests that test public tool behavior (compress-range, compress-message)
- Tests that test pure functions (token-counting, message-ids, shape, query)

**Structural tests** (white-box, must be rewritten for v2 module boundaries):
- Tests calling `prune(state, logger, config, messages)` directly → becomes PipelineStage
- Tests calling `syncCompressionBlocks(state, logger, messages)` → becomes stage
- Tests calling `injectCompressNudges(...)` → becomes stage
- Tests calling `applyCompressionState(...)` → moves to `state/mutations/blocks.ts`
- ~15-20 test files need logic rewrites

**Gate criterion**: All behavioral tests pass + all rewritten structural tests pass = behavioral equivalence verified.

### 7.3 Class B Code (Migration with Interface Adaptation)

These post-fork original modules are migrated, not rewritten. They need interface adaptation (import paths change, function signatures may change):

| Module | LOC | v2 Location | Adaptation |
|--------|-----|-------------|------------|
| compress/decompress.ts | 121 | compress/tools/decompress.ts | Import from state/mutations/ |
| compress/decompress-logic.ts | 200 | compress/tools/decompress-logic.ts | Minimal — pure logic |
| compress/mark-block.ts | 148 | compress/tools/mark-block.ts | Import from state/mutations/ |
| gc/merge.ts | 336 | gc/merge.ts | Import allocateBlock from state/mutations/ |
| subagents/subagent-results.ts | 156 | subagents/subagent-results.ts | Minimal |
| auth.ts | 37 | permissions/auth.ts | Minimal |
| compress-permission.ts | 25 | permissions/compress-permission.ts | Minimal |
| host-permissions.ts | 101 | permissions/host-permissions.ts | Minimal |
| protected-patterns.ts | 128 | permissions/protected-patterns.ts | Minimal |

**Total Class B**: ~1252 LOC. These are ranxianglei's original work, MIT-eligible.

---

## 8. What We're NOT Changing

1. **Plugin hook contract** — OpenCode's 5 hooks stay
2. **CompressionBlock data structure** — battle-tested, keep as-is
3. **Three-layer config merge concept** — keep concept, rewrite implementation
4. **Internal naming** — `dcp` tags/regex/schema URLs stay for backward compat
5. **Storage paths** — `plugin/acp/{sessionId}.json` stays
6. **Map serialization format** — same JSON structure (Maps serialize to objects via helpers)
7. **batchCleanup config** — `gc.batchCleanup.{lowThreshold, highThreshold, forceThreshold}` preserved
8. **All four model-facing tools** — compress, decompress, mark_block, unmark_block all preserved

---

## 9. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Behavioral divergence | Behavioral tests as spec gate — no merge until all pass |
| AGPL contamination | Clean-room protocol (§10) |
| Migration takes too long | Parallel development — lib/ keeps working until cutover |
| State format incompatibility | Persistence format unchanged (same JSON structure) |
| Test rewriting takes too long | Test classification (§7.2) — behavioral tests port directly |
| Rollback needed | lib/ preserved until cutover; revert = delete lib-v2/, restore old index.ts |

---

## 10. Clean-Room Protocol

### 10.1 Spec Sources

The behavioral specification consists of:
- **Test files** (tests/*.test.ts) — authored by ranxianglei (provenance: git blame shows all test commits by ranxianglei)
- **AGENTS.md** — data flow diagrams, module descriptions
- **devlog REQ.md** files — requirement documents

All spec tag strings (`dcp-message-id`, `dcp-system-reminder`, etc.) are discoverable from test assertions — no need to read lib/ source for tag formats.

### 10.2 Authoring Rules

**For new (Class A) code** — authored from spec only:
- The spec sources above are the ONLY reference
- lib/ source files must not be read during v2 authoring of Class A modules
- If any uncertainty arises that the spec doesn't cover, document it as an open question rather than reading lib/

**For Class B code** — migrated with adaptation:
- Reading is permitted (it's ranxianglei's own original work)
- Must adapt imports to new v2 module structure
- Must route state mutations through state/mutations/

### 10.3 Review Rules

v2 implementations must not be structural transforms of v1 code:
- Reviewers compare v2 files against v1 counterparts
- Flag if v2 function decomposition maps 1:1 to v1 by responsibility AND naming AND control flow
- Similar algorithms are acceptable (there are limited ways to prune a message); structural cloning is not
- The diff review is the enforcement mechanism, not the "don't read" rule

### 10.4 Spec Snapshot

Pin spec sources at commit `22498da` (current master after PR #23 merge). All v2 authoring references only this snapshot.

---

## 11. File Count Comparison

| Metric | v1 (lib/) | v2 (lib-v2/) | Change |
|--------|-----------|-------------|--------|
| Source files | 70 | ~85 | +21% (pipeline decomposition) |
| Largest file | config.ts (1125 LOC) | schema.ts (~250 LOC) | **-78%** |
| hooks.ts | 507 LOC | message-transform.ts (~60 LOC) | **-88%** |
| Pipeline | 1 function (23 steps) | 21 files (1 stage each) | Independently testable |
| Max file in compress/ | range.ts (600 LOC) | range-mode.ts (~300 LOC est.) | -50% |
| Total LOC | ~12,000 | ~11,500 (est.) | -4% (Class B migrated, not rewritten) |

**Value proposition**: Not fewer files, but **smaller files**. Max file size drops 78%. Every module is independently testable. The pipeline is composable.

---

## 12. Resolved Questions

1. **Pipeline stages async?** → Yes, all async. `PipelineStage.run` returns `Promise<void>`. Stages that are synchronous just return immediately; `await` on a resolved promise is negligible overhead.

2. **State container pattern?** → No. Explicit mutation functions are sufficient. Centralized mutation surface (all mutations in state/mutations/) provides discoverability without the complexity of Redux-style stores.

3. **Runtime config validation?** → No. Validate once at load via Zod schema. Runtime validation on every access is pure overhead.

4. **Integration tests?** → Already exist (e2e-message-transform.test.ts, e2e-blocks-nudges.test.ts). These are the behavioral gate for the rewrite. Additional integration tests can be added as needed.
