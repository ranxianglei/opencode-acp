# WORKLOG: Remove prune tool, sweep command, strategies, and dead code

## Branch
`2026-07-27_remove-prune-tool` from master `ce248b6` (v1.14.0)

## Phase-by-phase execution

### Phase 1 — `lib/messages/prune.ts` dead code removal
- Rewrote file keeping only: `prune()` export, `filterCompressedRanges`, `stripStepMarkers`,
  `MAX_STEP_FINISH_REASON`. Removed 4 dead functions (`pruneFullTool`, `pruneToolOutputs`,
  `pruneToolInputs`, `pruneToolErrors`), 3 dead replacement constants, HOTFIX comment.
- Preserved the two load-bearing comments: `[FIX preserve-first-user]` (Bug 1214 freeze) and
  prefix-cache-stability note on `stripStepMarkers` (AGENTS.md §4.4 convention).

### Phase 2 — `lib/strategies/` directory deletion
- Deleted `deduplication.ts`, `purge-errors.ts`, `index.ts`, then `rmdir` the empty directory.
- Removed import `{ deduplicate, purgeErrors }` and the two call lines from
  `lib/compress/pipeline.ts` `prepareSession()`.

### Phase 3 — Sweep command deletion
- Deleted `lib/commands/sweep.ts`.
- Removed `handleSweepCommand` export from `lib/commands/index.ts`.
- Removed `/acp sweep [n]` entry from `BASE_COMMANDS` in `lib/commands/help.ts`.
- Removed sweep dispatch block from `lib/hooks.ts` and the `handleSweepCommand` import.
- Left `workingDirectory` parameter on `createCommandExecuteHandler` (now unused but no harm —
  callers still pass it).

### Phase 4 — Prune tool deletion
- Deleted `lib/compress/prune-tool.ts`.
- Removed `createPruneTool` export from `lib/compress/index.ts`.
- Removed `createPruneTool` import + `prune: createPruneTool(...)` registration from `index.ts`.
- Removed `prune` bullet from TOOLS section in `lib/prompts/system.ts`.
- Also removed `strategies: config.strategies` log field from `index.ts` init log.

### Phase 5 — `state.prune.tools` Map removal
- `lib/state/types.ts`: removed `tools: Map<string, number>` from `Prune` interface.
- `lib/state/state.ts`: removed `tools: new Map()` from `createSessionState` + `resetSessionState`,
  removed `state.prune.tools = loadPruneMap(...)` from load, removed unused `loadPruneMap` import.
- `lib/state/utils.ts`: removed `state.prune.tools = new Map()` from `resetOnCompaction`. Also
  deleted the now-orphaned `loadPruneMap` helper (no callers remained).
- `lib/state/persistence.ts`: removed `tools: Object.fromEntries(...)` from serialization,
  loosened `hasPruneTools` check so old state files with `tools` still load, kept legacy
  tools read in `loadAllSessionStats` (read-only for aggregation counter).
- `lib/commands/stats.ts`: replaced `new Set(state.prune.tools.keys())` with `new Set()`.
- `lib/commands/context.ts`: removed `state.prune.tools.has(...)` check at line 152 and the
  entire dead loop at lines 187-192 (replaced with empty Set).
- `lib/ui/notification.ts`: removed `PruneReason`, `PRUNE_REASON_LABELS`,
  `buildMinimalMessage`, `buildDetailedMessage` (all dead). Removed `formatPrunedItemsList`
  import and `ToolParameterEntry` import (now unused).
- `lib/ui/utils.ts`: removed `extractParameterKey`, `formatStatsHeader`, `truncate`,
  `shortenPath`, `shortenSinglePath`, `formatPrunedItemsList` (all dead after notification
  cleanup). Removed `ToolParameterEntry` import.

### Phase 6 — Strategies config + `automaticStrategies` removal
- `lib/config.ts`: removed `Deduplication` + `PurgeErrors` interfaces, `strategies` field on
  `PluginConfig`, `automaticStrategies` field on `ManualModeConfig`, `mergeStrategies` function,
  entries in `defaultConfig` (both top-level `strategies` and `manualMode.automaticStrategies`),
  `deepCloneConfig`, `mergeConfig`.
- `lib/config-validation.ts`: removed `"manualMode.automaticStrategies"` and 8 `strategies.*`
  keys from `VALID_CONFIG_KEYS`; removed `automaticStrategies` validation block and entire
  strategies validation block (~75 lines).
- `dcp.schema.json`: removed `automaticStrategies` property from `manualMode`, removed entire
  `strategies` schema (~52 lines), updated sweep reference in `commands.protectedTools`
  description.

### Phase 7 — Strategy test files deletion
- Deleted `tests/strategies-dedup.test.ts` and `tests/strategies-purge-errors.test.ts`.

### Phase 8 — `tests/prune.test.ts` surgical edits
- Removed `automaticStrategies: true` from `manualMode` and the `strategies: { ... }` block
  from `buildConfig()`.
- Removed 5 dead tests that used `state.prune.tools.set(...)`: `prune preserves completed tool
  outputs (prefix cache fix)`, `prune does not replace question/edit/write tool outputs`,
  `prune does not replace tool outputs for tools not in prune set`, `prune does not replace
  outputs for error-status tools`, `prune preserves question tool inputs`, `prune does not
  replace question input for non-question tools`, `prune preserves error tool inputs`, `prune
  does not replace inputs for completed tools in error pruning`, `prune handles mixed scenario:
  compressed range + tool output pruning`.

### Phase 9 — `tests/persistence.test.ts` cleanup
- Removed `state.prune.tools.set("call-1", 1)` from save test and the `content.prune.tools["call-1"]`
  assertion.
- Removed `state.prune.tools.set("tool-a", 1)` + `state.prune.tools.set("tool-b", 2)` from
  round-trip test and the two loaded-state assertions.

### Phase 10 — All test `buildConfig()` factories cleaned
- 16 files had `manualMode: { enabled: false, automaticStrategies: true }` (inline) → sed-replaced
  to `manualMode: { enabled: false }`.
- 8 files had multi-line `manualMode: { enabled: false, automaticStrategies: true, }` → sed-removed
  the `automaticStrategies: true,` line.
- 24 files had `strategies: { deduplication: ..., purgeErrors: ... }` blocks (single-line or
  multi-line variant) → Python regex script removed all of them.
- Cleaned up unused import in `tests/state-utils-pure.test.ts` (removed `loadPruneMap` import).
- Total: 24 files modified.

### Phase 11 — `tools: new Map()` removal from mock state factories
- 9 files had `tools: new Map(),` on its own line → sed-removed.
- 1 file (`tests/summary-buffer-visibility.test.ts`) had inline pattern → manual edit.

### Phase 12 — E2E test cleanup
- `tests/e2e-message-transform.test.ts`: removed `prune: pruned tool outputs are preserved
  (prefix cache fix)` test (used `state.prune.tools.set`).
- `tests/e2e-blocks-nudges.test.ts`: removed `tool error pruning: error tool inputs are
  preserved (prefix cache fix)` test (used `state.prune.tools.set`).

### Phase 13 — Regression test added
- New file: `tests/remove-prune-regression.test.ts` with 8 tests:
  1. `prune()` export still callable, mutates via `filterCompressedRanges`
  2. `prune()` strips step-start via `stripStepMarkers`
  3. `Prune` type no longer has `tools` field (compile-time check via conditional type)
  4. `createSessionState().prune` has no `tools` Map (runtime check)
  5. `resetSessionState()` produces a prune with no `tools` Map
  6. `deduplicate` / `purgeErrors` no longer called in `prepareSession` (calls it with stub
     client, verifies it doesn't throw)
  7. `isMessageCompacted` still works
  8. `createPruneTool` and `handleSweepCommand` exports removed (runtime check)

### Phase 14 — Devlog
- This REQ.md + WORKLOG.md.

## Side discovery — fixed latent `export { ToolContext }` bug

The new regression test #8 imports the compress barrel via
`import * as compressMod from "../lib/compress"`. This triggers Node's native ESM loader, which
rejects `export { ToolContext } from "./types"` because `ToolContext` is an interface (type-only)
and Node treats the re-export as a value binding. No prior test exercised this path. Fixed by
changing line 1 of `lib/compress/index.ts` to `export type { ToolContext } from "./types"`.
This is a strict improvement (type-only re-export is the correct semantics for an interface)
and matches `verbatimModuleSyntax`-style best practice.

## Verification

```
$ npm run typecheck    # 0 errors
$ npm run test         # 879 pass, 0 fail (45.4s)
$ npm run build        # succeeds
$ grep -r 'createPruneTool\|handleSweepCommand\|deduplicate\|purgeErrors\|state\.prune\.tools' lib/ index.ts
                       # (no output)
```

## Files changed

Source code (16 files):
- `index.ts`
- `lib/compress/index.ts` (+ latent type-only-export fix)
- `lib/compress/pipeline.ts`
- `lib/commands/help.ts`
- `lib/commands/index.ts`
- `lib/commands/context.ts`
- `lib/commands/stats.ts`
- `lib/config.ts`
- `lib/config-validation.ts`
- `lib/hooks.ts`
- `lib/messages/prune.ts`
- `lib/prompts/system.ts`
- `lib/state/persistence.ts`
- `lib/state/state.ts`
- `lib/state/types.ts`
- `lib/state/utils.ts`
- `lib/ui/notification.ts`
- `lib/ui/utils.ts`
- `dcp.schema.json`

Deleted (5 files):
- `lib/commands/sweep.ts`
- `lib/compress/prune-tool.ts`
- `lib/strategies/deduplication.ts`
- `lib/strategies/purge-errors.ts`
- `lib/strategies/index.ts`
- `tests/strategies-dedup.test.ts`
- `tests/strategies-purge-errors.test.ts`

Tests modified (27 files):
- `tests/prune.test.ts`
- `tests/persistence.test.ts`
- `tests/state-utils-pure.test.ts`
- `tests/e2e-message-transform.test.ts`
- `tests/e2e-blocks-nudges.test.ts`
- `tests/summary-buffer-visibility.test.ts`
- `tests/batch-compress.test.ts`
- `tests/compression-groups.test.ts`
- `tests/compress-message.test.ts`
- `tests/compress-range.test.ts`
- `tests/e2e-tier-compression.test.ts`
- `tests/e2e-tier-simulation.test.ts`
- `tests/gc-merge.test.ts`
- `tests/hooks-permission.test.ts`
- `tests/inject.test.ts`
- `tests/keep-markers.test.ts`
- `tests/message-priority.test.ts`
- `tests/nudge-text.test.ts`
- `tests/pipeline.test.ts`
- `tests/preserve-recent.test.ts`
- `tests/proportional-baseline.test.ts`
- `tests/protected-tool-exclusion.test.ts`
- `tests/quality-gate-enforcement.test.ts`
- `tests/quality-gate-pipeline-integration.test.ts`
- `tests/query-mock.test.ts`
- `tests/rebuild.test.ts`
- `tests/soft-block.test.ts`
- `tests/token-usage.test.ts`
- `tests/phantom-block.test.ts`
- `tests/message-ids.test.ts`
- `tests/recap.test.ts`
- `tests/search-context.test.ts`
- `tests/tier-token-usage.test.ts`
- `tests/acp-status.test.ts`
- `tests/compress-search.test.ts`
- `tests/compress-state.test.ts`

Tests added:
- `tests/remove-prune-regression.test.ts` (8 tests)

Devlog:
- `devlog/2026-07-27_remove-prune-tool/REQ.md`
- `devlog/2026-07-27_remove-prune-tool/WORKLOG.md` (this file)
