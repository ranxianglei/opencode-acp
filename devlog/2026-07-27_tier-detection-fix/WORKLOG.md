# WORKLOG: Tier Detection Fix

## Phase 1: Root Cause Analysis

Analyzed session `ses_0b89319b1ffeK25eKU3GMfCK8U` (8131 msgs, 133 blocks):
- 18 blocks labeled tier=2
- 6 misclassified (directMessageIds 14-103, consumed 1 old T1 block incidentally)
- 10 real T2 (0-4 direct msgs, consumed via b-prefix boundaries)
- 0 from automatic T2 trigger

Root cause: `state.ts:80-94` used `consumedBlockIds` to determine tier. Any consumed
block → tier goes up. But consumed blocks can appear in T1 compressions when the
range happens to overlap an existing block's anchor.

## Phase 2: Fix Implementation

Changed tier detection in `lib/compress/state.ts:80-107`:
- Added `isBlockBoundary` check using `selection.startReference?.kind` / `selection.endReference?.kind`
- Message boundaries → tier=1 (regardless of consumedBlockIds)
- Block boundaries → tier = `max(consumed tier) + 1` (previous logic)
- `targetTierForConsumption`: T1 → 1, T2+ → `minConsumedTier`

## Phase 3: Tests

New file `tests/tier-detection-fix.test.ts` (7 tests):
1. T1 with message boundaries + old T1 consumed → tier=1
2. T1 with no consumed blocks → tier=1
3. T1 consuming old T1 → old block deactivated, messages inherited
4. T2 with block boundaries consuming T1 → tier=2
5. T3 with block boundaries consuming T2 → tier=3
6. Mixed boundary (message + block) → T2+
7. Regression: 91-msg T1 with incidental T1 overlap → tier=1

## Phase 4: Existing Test Updates

3 existing tests in `tests/e2e-tier-compression.test.ts` needed `startReference`/
`endReference` with `kind: "compressed-block"` added to their T2/T3 compression
selections (they previously omitted these fields, relying on the old consumedBlockIds-
based detection).

## Verification

- 929/929 tests pass (922 existing + 7 new)
- TypeScript: 0 errors
