# WORKLOG - mark_block + Batch Cleanup

- Task ID: `2026-06-26_mark-block-batch-cleanup`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-06-26

## 1. Summary

- **What was done**: Implemented the `mark_block` / `unmark_block` tools and a three-tier batch merge-cleanup mechanism that consolidates marked (or force-targeted old-gen) compression blocks into a single summary as context pressure rises.
- **Why**: Gives the model a zero-cache-cost way to flag blocks it no longer needs, deferring all consolidation into one cache break at high pressure instead of losing information to blind age-based GC at low pressure.
- **Behavior / compatibility changes**: Yes — additive only. New optional state field (`markedForCleanup`) and new required config sub-object (`gc.batchCleanup`, always populated from defaults). Existing GC logic is untouched and remains the ultimate fallback at 100%. Old persisted state files without `markedForCleanup` load fine (defaults to empty set). Old user configs without `gc.batchCleanup` use defaults via deep-merge.
- **Risk level**: Low

## 2. Change Log

### Commits

Not committed — changes left uncommitted for review (per task instructions).

### Key Files

- `lib/state/types.ts` — added `markedForCleanup: Set<number>` to `PruneMessagesState`.
- `lib/state/utils.ts` — `createPruneMessagesState` initializes the set; `serializePruneMessagesState` writes it as an array; `loadPruneMessagesState` restores it (skips marks for non-existent blocks). Both local `PersistedPruneMessagesState` shapes gained `markedForCleanup?: number[]`.
- `lib/state/persistence.ts` — added `markedForCleanup?: number[]` to the on-disk `PersistedPruneMessagesState` interface.
- `lib/config.ts` — new `BatchCleanupConfig` interface; `batchCleanup` added to `GCConfig`; defaults (`60%/75%/90%`) in `DEFAULT_CONFIG`; `deepCloneConfig` clones it; new `mergeGC` deep-merges `batchCleanup` so partial user overrides keep default thresholds; `mark_block`/`unmark_block` added to `DEFAULT_PROTECTED_TOOLS`.
- `lib/config-validation.ts` — registered `gc.batchCleanup{,.lowThreshold,.highThreshold,.forceThreshold}` keys + type validation (number | `${number}%`).
- `dcp.schema.json` — added a `gc` property section (previously absent) including `batchCleanup` with the three thresholds.
- `lib/gc/merge.ts` — **new file**: `mergeMarkedBlocks()` and `runBatchCleanup()` plus helpers (`collectActiveMarkedBlocks`, `collectActiveOldGenBlocks`, `extractSummaryBody`, `truncateMergedSummary`, `percentToTokens`, `buildNudgeText`).
- `lib/hooks.ts` — imported `runBatchCleanup`; inserted the call between `runMajorGC()` and `prune()`; tier 1 appends nudge text to the last user message via new `appendBatchCleanupNudge`; tier 2/3 persists the mutated state.
- `lib/compress/mark-block.ts` — **new file**: `createMarkBlockTool` / `createUnmarkBlockTool` (session init + state mutation + persistence, mirroring the decompress tool pattern).
- `lib/compress/index.ts` — re-exported the two new tool factories.
- `index.ts` — registered `mark_block` / `unmark_block` in the `tool:` block (gated on `compress.permission !== "deny"`) and added them to `experimental.primary_tools`.
- `lib/prompts/system.ts` — documented `mark_block` / `unmark_block` in the tools description.
- `tests/*.test.ts` — added `batchCleanup` defaults to every `buildConfig`/`makeGCConfig` gc literal (10 files) so test configs match the updated `PluginConfig`/`GCConfig` types.

## 3. Design & Implementation Notes

- **Entry point / key function**: `runBatchCleanup(state, config, logger, messages)` in `lib/gc/merge.ts`, invoked from the message-transform pipeline in `lib/hooks.ts`.
- **Key configuration items**: `gc.batchCleanup.{lowThreshold,highThreshold,forceThreshold}` (number or `${number}%` of model context window). Defaults 60% / 75% / 90%.
- **Key logic explanation**:
    - `runBatchCleanup` computes current usage via `getCurrentTokenUsage`. If `modelContextLimit` is unknown it no-ops. Tier precedence: force(3) > high(2) > low(1) > none(0).
        - **Tier 3 (>= forceThreshold)**: gathers all active old-gen blocks (same selection as `runMajorGC`: `generation === "old" | undefined` or oversized) and merges them.
        - **Tier 2 (>= highThreshold)**: gathers active blocks in `markedForCleanup` and merges them.
        - **Tier 1 (>= lowThreshold)**: returns a `nudgeText` (only when marks exist); hooks.ts appends it to the last user message — cache-safe because the prefix already breaks there each turn.
    - `mergeMarkedBlocks` requires >= 2 valid active source blocks (a single-block "merge" is a no-op to avoid redundant work already covered by truncate-GC). It concatenates source summary bodies (header/footer stripped) with `\n---\n`, truncates to `maxOldGenSummaryLength` keeping each block's first line, wraps into a new old-gen block, deactivates all sources (`active=false`, `deactivatedByBlockId=newId`), transfers their `effectiveMessageIds`/`effectiveToolIds` union, re-points `activeByAnchorMessageId` to the new block at the oldest source's anchor, rewrites `byMessageId.activeBlockIds`, and clears `markedForCleanup`.
    - **No infinite loop**: after a tier-3 merge there is only one old-gen block, so the next run's `< 2` guard no-ops; after a tier-2 merge `markedForCleanup` is cleared.
    - State is **not** persisted inside `mergeMarkedBlocks`; the hooks.ts caller persists once when `mergedCount > 0`.
    - `resolveBatchCleanup` falls back to a constant default set when `config.gc.batchCleanup` is absent — defensive against partial configs / older test factories.
- **Persistence / serialization**: Sets are written as arrays (`Array.from`) and read back with integer/existence validation, consistent with the existing `activeBlockIds` handling. Backward compatible: a missing field yields an empty set.
- **Backward compatibility**: internal `dcp` naming untouched; existing GC untouched; no DB message modification; only ACP state is mutated.

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp
npm run typecheck   # tsc --noEmit (covers index.ts + lib/**)
npm run build       # clean + tsup + tsc --emitDeclarationOnly
npm run test        # node --import tsx --test tests/*.test.ts
```

### Test Coverage

- New/modified test files: no new test files (per scope — test review TBD). Updated 10 existing test factory `gc` literals to include `batchCleanup` defaults.
- The new code paths are exercised defensively at runtime but no existing test scenario crosses a batch-cleanup threshold (e2e tests run with `modelContextLimit` undefined or ~0.075% usage, so `runBatchCleanup` returns tier 0), guaranteeing no regression in existing assertions.
- Test count: **386 total, 386 pass, 0 fail** (unchanged from baseline).

### Results

- `npm run typecheck`: PASS
- `npm run build`: PASS (`dist/index.js` 319.87 KB)
- `npm run test`: PASS (386/386)
- `dcp.schema.json`: valid JSON (verified via `JSON.parse`)

## 5. Follow-ups / Notes

- Dedicated unit tests for `mergeMarkedBlocks` / `runBatchCleanup` and the `mark_block` tool were not added in this iteration (out of scope; flagged for a follow-up test-review pass per AGENTS.md §5.6).
- `compressMessageId` of merged blocks is set to `""` since no compress tool call produces them; downstream code that keys on `compressMessageId` for duration attachment (`attachCompressionDuration`) is unaffected because merged blocks have no matching start event.
- `gc` was missing from `dcp.schema.json` entirely; this iteration added the full `gc` section (with `batchCleanup`) so IDE autocomplete now reflects reality.
