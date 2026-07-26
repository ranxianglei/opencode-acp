# Worklog: 3-Tier Compression

## Phase 1: cc-alg (context-compress-algorithms)
**Branch**: `2026-07-25_tier-compression`, version `1.2.0-dev.1`

### New files
- `src/prompts/tier2-distill-rules.ts` — TIER2_DISTILL_RULES (KEEP: decisions/outcomes/lessons; DROP: paths/signatures/code; target 50-150 tok)
- `src/prompts/tier3-condense-rules.ts` — TIER3_CONDENSE_RULES (1-3 facts per block, ≤8 words each; target 10-30 tok)
- `src/trigger/tier.ts` — `computeTierTrigger(usage, config)`, `computeTierBudgets(totalBudget)`, types
  - Budget split: 60% T1 / 30% T2 / 10% T3
  - Priority: T1 > T2 > T3
- `tests/tier-trigger.test.ts` — 9 tests (budgets + trigger logic + boundary + priority)

### Updated
- `src/prompts/index.ts` — exports new prompts
- `src/trigger/index.ts` — exports tier types + functions
- `package.json` — version 1.0.0 → 1.2.0-dev.1

### Verification
- typecheck ✅ | 104 tests pass (97 existing + 9 new) ✅ | build ✅
- npm-linked to opencode-acp for local development

## Phase 2: opencode-acp — State + Types

### Changes
- `lib/state/types.ts`: Added `CompressionTier = 1 | 2 | 3` type + `tier?: CompressionTier` field to `CompressionBlock`
- `lib/compress/state.ts`: `applyCompressionState()` auto-detects output tier from consumed blocks
  - Logic: if consumed blocks have tier T, output = T+1, capped at 3
  - `b` prefix block ID resolution already supported by `parseBoundaryId`

## Phase 3: opencode-acp — Token Counting + Nudge Injection

### Changes
- `lib/state/utils.ts`: Added `getTierTokenUsage(state)` — returns `{tier1Tokens, tier2Tokens, tier3Tokens}`
- `lib/messages/inject/inject.ts`: Tier-specific nudge injection
  - After normal nudge logic, checks `computeTierTrigger()` from cc-alg
  - If tier 2/3 trigger fires AND no tier-1 ranges to compress → injects tier nudge
  - Lists oldest blocks with topics + token sizes
  - Includes TIER2_DISTILL_RULES or TIER3_CONDENSE_RULES prompt
  - Tells model to use `startId="bN", endId="bM"` for block compression
- `lib/prompts/system.ts`: Added MULTI-TIER COMPRESSION section explaining 3-tier mechanism

### Tests
- `tests/tier-token-usage.test.ts` — 6 tests for `getTierTokenUsage()`
- Full suite: 857 tests pass (851 existing + 6 new)

### Verification
- typecheck ✅ | 857 tests pass ✅ | build ✅ | deployed locally ✅

## Oracle Review Fixes (BLOCKER + MEDIUM)

After code review by Oracle (ses_066c46be), fixed 2 BLOCKERs + 2 MEDIUMs:

### BLOCKER 1: tier field dropped on state load
- **Problem**: `loadPruneMessagesState` reconstructs blocks field-by-field — `tier` was missing → tier-2/3 blocks revert to tier-1 after restart
- **Fix**: `lib/state/utils.ts:261` — Added `tier: block.tier === 1 || block.tier === 2 || block.tier === 3 ? block.tier : undefined`

### BLOCKER 2: checkPhantomBlock rejects tier-escalation
- **Problem**: `checkPhantomBlock` rejects compressions where all messages are already-compressed (phantom detection). Tier escalation (b3→b15) has ALL messages from consumed blocks → phantom rejection → tier system dead
- **Fix**: `lib/compress/pipeline.ts:216` — Carve-out: skip phantom check when `consumedBlockIds.length >= 2` (multi-block consumption = tier escalation)

### MEDIUM 3: Tier nudge fires every turn (no cadence)
- **Problem**: Tier nudge had no throttle → ~1K token overhead every turn until model complies
- **Fix**: Added `lastTierNudgeTokens` to Nudges state. Tier nudge only re-fires after `growthFloor` tokens of growth. Cleared on compress.

### MEDIUM 5: Count threshold too strict
- **Problem**: `candidates.length >= 3` blocks trigger when only 2 large blocks exist
- **Fix**: `candidates.length >= 3 OR candidateTokens >= tierBudgets.tier1Trigger`

### MEDIUM 4: bN→bM anchor order (deferred)
- Edge case: block IDs not matching anchor message order. In practice blocks are created sequentially → anchors follow order. Deferred.

### Files updated for state persistence
- `lib/state/types.ts` — Added `lastTierNudgeTokens: number | undefined`
- `lib/state/state.ts` — Init (2 places) + load from persistence
- `lib/state/persistence.ts` — PersistedNudges type + serialization
- `lib/state/utils.ts` — resetOnCompaction
- `lib/messages/inject/inject.ts` — Clear on compress + cadence gate

### Verification after fixes
- typecheck ✅ | 857 tests pass ✅ | build ✅ | deployed locally ✅

## Phase 4: Tier Trigger Redesign + hide-consumed

### Trigger redesign
- **Problem**: Original design used `computeTierTrigger()` fallback — T2/T3 only fired when T1 was suppressed. User feedback: each tier should trigger INDEPENDENTLY.
- **Fix**: `lib/messages/inject/inject.ts:366-418` — Removed fallback gate. Each tier checks its input summaries against `nudgeGrowthTokens` independently. T2 checks tier1Tokens, T3 checks tier2Tokens.
- **cc-alg**: `computeTierTrigger`/`computeTierBudgets` marked `@deprecated` (no longer imported by opencode-acp).

### hide-consumed module
- `lib/compress/hide-consumed.ts` — NEW: removes tool-call parts from consumed compress calls (those whose blocks are now tier 2+ inputs)
- `lib/hooks.ts` — Calls `hideConsumedCompressCalls()` after prune
- Prevents tier-2+ compress calls from showing both summary AND consumed blocks' summaries

### Status display improvements
- `lib/compress/status.ts` — Tier labels (T1/T2/T3), effective compressed tokens (recursive sum), tier breakdown line
- Effective tokens = block.compressedTokens + sum of consumed blocks' effective tokens

### Verification
- typecheck ✅ | 866 tests pass ✅ | build ✅

## Phase 5: cc-alg v1.2.0 publish + opencode-acp pin

### cc-alg release
- PR #2 merged on GitHub: https://github.com/ranxianglei/context-compress-algorithms/pull/2
- Version: 1.2.0-dev.1 → 1.2.0
- Published to npm: `context-compress-algorithms@1.2.0`

### opencode-acp version pin
- `package.json`: `"context-compress-algorithms": "^1.0.0"` → `"1.2.0"` (exact pin)
- Prevents incompatible versions from breaking runtime

### Verification
- typecheck ✅ | 866 tests pass ✅ | build ✅ with pinned 1.2.0

## Phase 6: Dual-Agent Review Fixes + Deferred Limitations

### First review fixes (commits 0523fe4 + c189eaa)
- **B1 BLOCKER**: `makeAssistantMessage` 3-arg call silently discarded tool output parts
- **M1/M5**: Dead code (`enoughCandidates` tautology), unsound tier cast
- **M2**: No tier persistence round-trip tests (added 3)
- **L1**: Unnecessary cast in hide-consumed.ts

### Deferred limitations fixed (commits f17dc5f + 16e270c + b88ec5f)

**Cross-tier contamination prevention**:
- `lib/messages/inject/inject.ts`: Sort candidates by blockId (ascending) instead of survivedCount. Safety check narrows suggested compress range when non-target active blocks exist between candidates by blockId, finding the largest contiguous sub-group.
- `lib/compress/state.ts`: `applyCompressionState` uses `minConsumedTier` (not `maxConsumedTier`) for output tier. Non-target-tier consumed blocks are NOT deactivated — their summaries remain visible via their own compress calls. `consumedBlockIds` and `includedBlockIds` on the new block only include target-tier blocks.

**effectiveCompressedTokens for T2+ blocks**:
- `lib/state/types.ts`: New optional `effectiveCompressedTokens?: number` field on CompressionBlock
- `lib/compress/state.ts`: Computed at creation time as `compressedTokens + sum of consumed blocks' effectiveCompressedTokens`. Used for `pruneTokenCounter`/`totalPruneTokens` stats instead of raw `compressedTokens`.
- `lib/state/utils.ts`: Parsed in `loadPruneMessagesState` with validation + fallback to undefined
- `lib/ui/notification.ts`: Log uses `effectiveCompressedTokens ?? compressedTokens`
- `lib/compress/status.ts`: `getEffectiveCompressedTokens` prefers stored field, falls back to recursive computation for old state files
- `lib/commands/compression-targets.ts`: Sum uses `effectiveCompressedTokens ?? compressedTokens`

### New tests (6)
- T2 trigger narrows range when non-target (T2) block between T1 candidates
- applyCompressionState mixed-tier consumption produces minTier+1
- T2 block gets effectiveCompressedTokens = consumed T1 tokens
- T1 block gets effectiveCompressedTokens = compressedTokens
- effectiveCompressedTokens round-trip through loadPruneMessagesState
- Missing effectiveCompressedTokens defaults to undefined

### Verification
- typecheck ✅ | 875 tests pass ✅ (869 + 6 new)

## Phase 7: Independent Tier Trigger Refactor + E2E Simulation

### Trigger redesign
- **Problem**: Previous design used `lastTierNudgeTokens` as a single counter. User feedback: each tier needs independent cadence.
- **Fix**: `lib/messages/inject/inject.ts:366-465` — Split into `lastTier2NudgeTokens` and `lastTier3NudgeTokens`. Unified tier trigger loop: checks T2 (tier1Tokens >= threshold) and T3 (tier2Tokens >= threshold) independently. T1 has priority via `!shouldInject` guard.
- Removed dead code from cross-tier fix (`maxConsumedTier`, unused variable)

### E2E simulation tests
- `tests/e2e-tier-simulation.test.ts` — 8 tests: 30-turn real session, T2/T3 priority, cadence, cross-tier narrowing, independent counters
- `scripts/simulate-tier-lifecycle.ts` — 5-year lifecycle simulation (T1 every 7d, T2 every 309d, T3 every 3091d)

### cc-alg version pin
- Pinned to exact `1.2.1` (was `^1.0.0`)

### Verification
- typecheck ✅ | 905 tests pass ✅

## Phase 8: Tier-Aware Decompress + E2E Round-Trip Tests

### Tier-aware decompress
- **Problem**: `decompress({blockId})` always restored to raw messages. For T2/T3 blocks, this is extremely expensive.
- **Fix**: `lib/compress/decompress-logic.ts:120-148` — `deactivateCompressionTarget(state, target, {full?})`
  - Default (no options): does NOT mark consumed blocks → sync reactivates them (one level up)
  - `{full:true}`: recursive BFS walk marks ALL descendants as `deactivatedByUserDeep`

### E2E round-trip tests
- `tests/e2e-tier-compression.test.ts` — 4 new tests:
  1. compress→decompress→deepEqual content identical
  2. decompress→recompress→exactly 1 active block, no duplicate
  3. T3 default decompress→T2 reactivated, T1 stays inactive
  4. T3 full:true→all descendants deactivatedByUserDeep

### Dual-agent review fixes (commit 3e090aa)
- M1: full:true recursive BFS for T3+
- M2: stats use compressedTokens (not effectiveCompressedTokens) — no double-count
- M3: Fixed broken SIM 1 assertion + type guards
- M4: minConsumedTier default REVERTED (3→1 broke T3, back to 3)
- M5: Removed @ts-expect-error

### Verification
- typecheck ✅ | 919 tests pass ✅

## Phase 9: sync.ts Anchor-Survival Fix

### Problem
- `syncCompressionBlocks` deactivated blocks when `anchorMessageId` not in current messages
- Caused **1137 blocks across 21 sessions** to be incorrectly deactivated when opencode compaction removed old compress tool calls

### Fix
- `lib/messages/sync.ts`: Removed anchor-missing check entirely. Block existence IS proof (same as Bug 3 for compressMessageId).
- 4 tests updated: blocks now stay active when anchor gone

## Phase 10: Full-Branch Dual-Agent Review Fixes

### Review results
- **Oracle** (8m25s): APPROVE — 2 MEDIUM + 6 LOW
- **General** (11m50s): All findings fixed (1 HIGH downgraded to LOW + 6 MEDIUM + 3 LOW)

### Fixes (4 commits: 66739d5, 7f60893, 51b1142, b818090)
- **M1**: `minConsumedTier` uses `undefined` sentinel instead of magic init=3. Consumed IDs that don't resolve → T1 safe default.
- **M2**: `effectiveMessageIds` filtered by `targetTierForConsumption`. Non-target-tier blocks don't pollute effective set.
- **M3**: Phantom carve-out requires homogeneous tier (`tiers.size === 1`). Mixed-tier no longer bypasses rejection.
- **M4**: `deactivatedByUserDeep` field for `full:true` recursive decompress. Recompress clears it recursively.
- **M5**: Test renamed to match actual behavior (T1 priority, not independent).
- **M6**: `parentBlockIds` fixed from reversed to `[]`.
- **L1**: Removed `missingOriginBlockIds` dead code.
- **L2**: `includedBlockIds` stores ALL consumed (unfiltered). Status display uses it.
- **L3**: No actual mismatch — README and WORKLOG consistent.

### Verification
- typecheck ✅ | **919 tests pass** ✅ | build ✅
