# WORKLOG: GC Removal + Emergency Tool Output Truncation

## Timeline

### Phase 1: Bug Hunt (commits ce31111, 7afd7c3)

Used property-based testing (fast-check) to fuzz the GC module. Found 4 defects:

- `truncateSummary` single-line path: output = `maxLength + 19` chars (marker not reserved)
- `truncateSummary` long-header path: output can be `>> maxLength` (header bypasses limit)
- `truncateSummary` barely-over case: `savedChars <= 0`, block silently NOT updated
- `truncateSummary` multiline path: reserves 20 chars for 19-char marker

### Phase 2: GC Removal (commit df3bbaf)

1. Deleted `lib/gc/truncate.ts`, `tests/gc-truncate-mock.test.ts`, `tests/gc-truncate-pure.test.ts`
2. Removed `runMajorGC` function from `hooks.ts` (was lines 124-166)
3. Removed GC import from `hooks.ts` line 43
4. Removed `runMajorGC(state, config, logger, output.messages)` call from pipeline (was line 229)
5. Removed aging warning section from `nudge.ts` lines 94-130 (referenced GC threshold)
6. Removed `gcConfig` parameter from `buildCompressedBlockGuidance` (no longer needed)
7. Updated call sites in `inject.ts:550` and `manual.ts:38`

### Phase 3: New Truncation Module (commit df3bbaf)

Created `lib/messages/truncate-tools.ts`:
- `truncateLargeToolOutputs()` — called after `prune()` in the message transform pipeline
- Triggers at `gc.majorGcThresholdPercent` (default "100%")
- Finds tool output parts with >1000 tokens, sorted largest first
- Truncates by keeping 2000-char prefix + 2000-char suffix
- Protects last 3 messages
- Never touches summaries
- Idempotent: checks for existing truncation marker

### Phase 4: Test Cleanup (commit df3bbaf)

Rewrote `tests/property-bughunt.test.ts`:
- Removed all GC-dependent tests (10 tests deleted)
- Kept MessageIDs (3 tests), Sync (4 tests), Prune (4 tests) property tests
- 926 total tests pass

## Design Decisions

1. **Why truncate tool outputs, not summaries?**
   - Summaries = model-written distilled info (~10% of context). Truncating destroys memory.
   - Tool outputs = verbose logs/listings (~40-60% of context). High redundancy, low density.
   - User explicitly confirmed: "summary 不要做任何截断 summary 一般只占百分之十以下"

2. **Why keep `config.gc` fields?**
   - Backward compatibility: existing user configs with `gc` section won't break
   - `majorGcThresholdPercent` is reused as the trigger threshold for new truncation
   - `promotionThreshold` still used in `applyCompressionState` for young→old generation tracking

3. **Why 2000 chars for prefix/suffix?**
   - ~500 tokens each — enough to preserve the beginning (what the tool was) and end (final result)
   - Total kept: ~1000 tokens per truncated output — still meaningful but much smaller than original

## Verification Results

```
tests 926, pass 926, fail 0
TypeScript: clean
Build: clean (453KB bundle)
```
