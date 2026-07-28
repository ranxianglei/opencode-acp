# REQ: Remove prune tool, sweep command, deduplication/purge-errors strategies, and all dead code

## Background

The `prune` tool, `/acp sweep` command, and `deduplication`/`purgeErrors` strategies have been
non-functional since the Bug 38 fix (PR #161) disabled the in-place message mutation they
depend on. Mutating existing messages in-place broke GLM prefix cache, causing 89% of fresh
input tokens to be wasted on cache-invalidating re-sends. The disabled functions continued to
add entries to `state.prune.tools` Map, but nothing read that Map for actual context modification.

The three-tier compression system (T1/T2/T3, introduced in v1.14.0) fully replaces any
functionality these mechanisms were supposed to provide. `compress` (via `filterCompressedRanges`)
is now the only active context reduction mechanism.

## Goal

Remove all prune/sweep/strategy code to:
- Delete ~205+ lines of dead code
- Simplify the configuration surface (drop `strategies` block, `manualMode.automaticStrategies`)
- Drop a tool the model should no longer call (`prune`)
- Drop a slash command that no longer has any effect (`/acp sweep`)

## Scope — What's Removed

### Source code
- `lib/messages/prune.ts`: dead functions `pruneFullTool`, `pruneToolOutputs`, `pruneToolInputs`,
  `pruneToolErrors`; dead constants `PRUNED_TOOL_OUTPUT_REPLACEMENT`,
  `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT`, `PRUNED_QUESTION_INPUT_REPLACEMENT`; HOTFIX comment block.
- `lib/strategies/` directory entirely: `deduplication.ts`, `purge-errors.ts`, `index.ts`.
- `lib/compress/prune-tool.ts` (the `prune` tool definition).
- `lib/commands/sweep.ts` (the `/acp sweep` handler).
- `lib/state/utils.ts`: dead `loadPruneMap` helper (no callers after `state.prune.tools` removal).
- `lib/ui/notification.ts`: dead `buildMinimalMessage`, `buildDetailedMessage`, `PruneReason`,
  `PRUNE_REASON_LABELS`.
- `lib/ui/utils.ts`: dead `extractParameterKey`, `formatStatsHeader`, `truncate`, `shortenPath`,
  `shortenSinglePath`, `formatPrunedItemsList`.
- `lib/config.ts`: `Deduplication`, `PurgeErrors` interfaces, `strategies` field on `PluginConfig`,
  `automaticStrategies` field on `ManualModeConfig`, `mergeStrategies` function, related entries in
  `defaultConfig`, `deepCloneConfig`, `mergeConfig`.
- `lib/config-validation.ts`: `manualMode.automaticStrategies` and all 8 `strategies.*` valid keys,
  `automaticStrategies` validation block, strategies validation block (~75 lines).
- `dcp.schema.json`: `automaticStrategies` property, entire `strategies` schema (~52 lines), sweep
  mention in description.

### State
- `Prune.tools: Map<string, number>` field removed from `lib/state/types.ts`.
- `state.prune.tools` initialization removed from `createSessionState`, `resetSessionState`,
  `resetOnCompaction`, state load.
- Persistence: `tools` field no longer serialized; load validation loosened so old state files
  with `tools` still load (we just ignore it).
- `loadAllSessionStats` still reads `state.prune.tools` from legacy on-disk state files for the
  aggregation counter (read-only, no writes).

### Tool/command surface
- `createPruneTool` export removed from `lib/compress/index.ts`.
- `prune: createPruneTool(...)` registration removed from `index.ts`.
- `prune` tool bullet removed from `lib/prompts/system.ts` TOOLS list.
- `handleSweepCommand` export removed from `lib/commands/index.ts`.
- Sweep dispatch block removed from `lib/hooks.ts`.
- `/acp sweep [n]` entry removed from `lib/commands/help.ts`.
- `deduplicate`/`purgeErrors` imports + calls removed from `lib/compress/pipeline.ts`.
- `state.prune.tools.has(...)` checks removed from `lib/commands/context.ts`,
  `lib/commands/stats.ts`.
- `strategies: config.strategies` log line removed from `index.ts` initialization log.

### Tests
- `tests/strategies-dedup.test.ts` deleted.
- `tests/strategies-purge-errors.test.ts` deleted.
- 5 dead tests removed from `tests/prune.test.ts` (the ones using `state.prune.tools.set`).
- 2 E2E tests removed (one in `tests/e2e-message-transform.test.ts`, one in `tests/e2e-blocks-nudges.test.ts`)
  that exercised the dead `state.prune.tools` path.
- 5 `loadPruneMap` tests removed from `tests/state-utils-pure.test.ts`.
- All test `buildConfig()` factories cleaned: `strategies: { ... }` block and
  `manualMode.automaticStrategies` field removed across 24 test files.
- All mock-state factories cleaned: `tools: new Map()` line removed from 10 test files.
- New `tests/remove-prune-regression.test.ts` with 8 regression tests verifying the removal.

## Scope — What's Preserved (Load-Bearing)

- `prune()` export in `lib/messages/prune.ts` — still calls `filterCompressedRanges` +
  `stripStepMarkers`. Hooks still import and call it.
- `filterCompressedRanges` — the only active context reduction mechanism (filters messages with
  active compression blocks).
- `stripStepMarkers` — strips step-start, truncates long step-finish reasons, idempotent for
  prefix-cache stability.
- `state.prune.messages: PruneMessagesState` — the entire compression-block state (byMessageId,
  blocksById, activeBlockIds, etc.).
- `MAX_STEP_FINISH_REASON = 50` constant.
- The `[FIX preserve-first-user]` and prefix-cache-stability comments — they document load-bearing
  bug fixes (AGENTS.md §4.4 convention).
- Backward-compat tolerance: old persisted state files with `prune.tools` still load (we just
  ignore the field). The aggregation counter in `loadAllSessionStats` still reads legacy tools
  from disk for the all-time-tools-pruned metric.
- `lib/compress/range.ts`, `lib/compress/message.ts`, `lib/compress/state.ts` — compression
  logic untouched.

## Non-Goals

- No version bump in `package.json` (release branch will handle it).
- No persisted state migration — old files load with `tools` ignored.
- No changes to three-tier compression (T1/T2/T3) or GC behavior.

## Verification

1. `npm run typecheck` — 0 errors
2. `npm run test` — all 879 remaining tests pass (was 922 before deletion; removed 5 dead prune
   tests, 5 dead loadPruneMap tests, 2 E2E tests, all strategies tests; added 8 regression tests)
3. `npm run build` — succeeds
4. `grep -r 'createPruneTool\|handleSweepCommand\|deduplicate\|purgeErrors\|state.prune.tools' lib/ index.ts`
   — returns nothing in source code

## Out of Scope (Pre-existing)

A latent runtime bug was discovered and fixed as a side effect: `lib/compress/index.ts` had
`export { ToolContext } from "./types"` which re-exports an interface as a value. Under Node's
native ESM loader (used when something does `import * as compressMod from "../lib/compress"`),
this raises `SyntaxError: The requested module './types' does not provide an export named
'ToolContext'`. Changed to `export type { ToolContext } from "./types"`. No existing test
exercised this path before; the new regression test does.
