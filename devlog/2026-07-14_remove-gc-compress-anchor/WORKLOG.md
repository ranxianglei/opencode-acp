# WORKLOG: Remove GC + Compress-as-Anchor + Emergency Strategy

## Branch
`2026-07-14_remove-gc-compress-anchor` (from `github/master` at v1.12.4)

## Phase 1: Complete GC Removal

### lib changes
- **`lib/hooks.ts`**: Removed imports `runTruncateGC, shouldRunMajorGC, getGCParams` from `./gc/truncate` + `runBatchCleanup` from `./gc/merge`. Removed entire `runMajorGC()` function (~85 lines). Removed pipeline calls `runMajorGC(...)` + `runBatchCleanup(...)` + associated `saveSessionState`.
- **`lib/config.ts`**: Removed `BatchCleanupConfig` + `GCConfig` interfaces, `gc` from `PluginConfig`, `gc` default section, `gc` from `deepCloneConfig()`, `mergeGC()` function, `gc: mergeGC(...)` from `mergeLayer()`. Old configs with `gc` section silently ignored.
- **`lib/compress/state.ts`**: Removed `GCConfig` import, `DEFAULT_PROMOTION_THRESHOLD`, `gcConfig` param from `applyCompressionState()`, survivedCount/generation promotion loop. KEPT `survivedCount: 0, generation: "young"` fields on new block creation (persisted state compat).
- **`lib/compress/range.ts`** + **`lib/compress/message.ts`**: Removed `ctx.config.gc` arg from `applyCompressionState()` calls.
- **`lib/state/rebuild.ts`**: Removed `GCConfig` import, `gcConfig` param from `rebuildRangeInvocation()` + `rebuildMessageInvocation()`.
- **`lib/prompts/extensions/nudge.ts`**: Removed `GCConfig` import, `gcConfig` param from `buildCompressedBlockGuidance()`, entire aging warning block (promotionThreshold, agingBlocks loop, truncation warning).
- **`lib/commands/manual.ts`**: Changed `buildCompressedBlockGuidance(state, config.gc)` → `buildCompressedBlockGuidance(state)`.
- **`lib/messages/inject/inject.ts`**: Changed `buildCompressedBlockGuidance(state, config.gc, {...})` → `buildCompressedBlockGuidance(state, {...})`.
- **`lib/compress/status.ts`**: Removed `sort === "age"` branch, removed `age=` and `gen=` from block detail display.
- **`lib/config-validation.ts`**: Removed all `gc.*` keys from `VALID_CONFIG_KEYS` allowlist (10 keys). Removed entire gc validation block (~95 lines).
- **`dcp.schema.json`**: Removed entire `gc` property definition (~83 lines).

### Deleted files
- `lib/gc/truncate.ts` (83 lines)
- `lib/gc/merge.ts` (239 lines)

### Test changes
- Deleted: `tests/gc-merge.test.ts`, `tests/gc-truncate-mock.test.ts`, `tests/gc-truncate-pure.test.ts`
- `tests/compress-state.test.ts`: Removed `GCConfig` import + 2 promotion tests
- `tests/acp-status.test.ts`: Removed `age=`/`gen=` assertions, deleted age-sort test
- `tests/e2e-blocks-nudges.test.ts`: Deleted GC deactivation test
- `tests/compress-rollback.test.ts`: Removed `GCConfig` import + `defaultGcConfig`
- Removed dead `gc` config blocks from 15 test files (via background task bg_c75241fa)

### Verification
- TypeScript: PASS | Tests: 650 pass, 0 fail | Build: success

## Phase 2: Compress-as-Anchor

### lib changes
- **`lib/messages/prune.ts`**: Removed synthetic recap injection (entire `createSyntheticToolRecap` block), removed `computeBlockRange` helper, removed `stripStaleCompressCalls` function, removed imports of `createSyntheticToolRecap`, `replaceBlockIdsWithBlocked`, `stripStaleMessageRefs`, `isIgnoredUserMessage`. NEW behavior: `filterCompressedRanges` ONLY hides messages with `activeBlockIds` in `byMessageId`.
- **`lib/hooks.ts`**: Removed `stripStaleCompressCalls` import + call.
- **`lib/messages/index.ts`**: Changed `export { prune, stripStaleCompressCalls }` → `export { prune }`.
- **`lib/messages/sync.ts`**: Changed deactivation check from `block.anchorMessageId` to `block.compressMessageId ?? block.anchorMessageId` (fallback for old persisted state).

### Test changes (via background task bg_4dee684e)
- Deleted: `tests/strip-stale-compress.test.ts` (entire file tests removed function)
- `tests/prune.test.ts`: Deleted 4 recap-injection-only tests, updated 1 test (removed recap assertions)
- `tests/message-priority.test.ts`: Deleted 2 tests (recap rendering), removed unused `prune` import
- `tests/sync.test.ts`: Added `userMsg("compress-1")` to 3 tests (blocks now need `compressMessageId` in message list)
- `tests/e2e-blocks-nudges.test.ts`: Added compress messages to block consumption test
- `tests/e2e-message-transform.test.ts`: Added compress messages, removed recap assertions (4 tests)

## Phase 3: Emergency Pruning

### New module: `lib/messages/emergency-prune.ts`
- `runEmergencyPrune(state, config, logger, messages, currentTokens, modelContextLimit): EmergencyPruneResult`
- `resolveThreshold(value, modelContextLimit)`: parses `number | "NN%"` → absolute tokens
- Logic: if `currentTokens >= threshold`, stubs old (before lastUserIdx) non-protected tool outputs with `[Output emergency-pruned to prevent context overflow]` until `targetReduction` reached.
- Uses `messageContainsProtectedTool` to skip protected tools.
- NO state mutation, NO persistence — ephemeral transform-time filtering.

### Config changes
- **`lib/config.ts`**: Added `emergencyPruneThreshold` (default "95%") + `emergencyPruneTarget` (default "85%") to `CompressConfig`.
- **`lib/config-validation.ts`**: Added both keys to allowlist + validation.
- **`dcp.schema.json`**: Added property definitions + defaults.

### hooks.ts integration
Added after `prune()`, before `assignMessageRefs()`:
```typescript
if (state.modelContextLimit && prePruneTokens > 0) {
    runEmergencyPrune(state, config, logger, output.messages, prePruneTokens, state.modelContextLimit)
}
```

## Final Verification
- TypeScript: PASS
- Build: PASS (378K)
- Tests: 637 pass, 0 fail
- CI check: PASS
