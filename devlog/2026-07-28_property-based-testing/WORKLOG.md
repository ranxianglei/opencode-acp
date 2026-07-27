# WORKLOG — Property-Based Testing POC

## Steps

1. Created worktree from `github/master` (`1c5c68d`, v1.14.4 merged).
2. Installed `fast-check` as devDependency.
3. Studied `lib/messages/inject/inject.ts` (825 lines) and `lib/messages/inject/utils.ts` (1153 lines) to identify pure decision functions and understand the nudge pipeline.
4. Studied the trigger policy source (`context-compress-algorithms` package) to understand `computeShouldNudge` semantics: `shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit`.
5. Created `tests/property-invariants.test.ts` with 10 property-based tests:
   - INV1: `excludeProtectedRanges` never returns ranges touching protected refs (500 runs)
   - INV2: `buildCompressibleRanges` groups never span protected boundary (200 runs)
   - INV3: `computeProtectedRefs` includes last N visible messages (200 runs)
   - INV4a: `computeShouldNudge` returns false when currentTokens undefined (30 runs)
   - INV4b: `computeShouldNudge` returns false on first turn (30 runs)
   - INV4c: `computeShouldNudge` returns false when growth not met and not overMaxLimit (30 runs)
   - INV5: `filterRecommendedRanges` suppressed implies effective below threshold (300 runs)
   - INV6: Pipeline nudge text injected implies shouldInjectThisTurn (50 runs)
   - INV7: Pipeline compress attempt clears all nudge anchors (30 runs)
   - BONUS: Pipeline idempotency — no double "Breakdown:" (30 runs)

6. fast-check caught two issues during development:
   - **INV4 (original)**: Assumed `shouldNudge` requires being over limits. fast-check proved wrong — policy uses growth-based cadence. Split into INV4a/b/c with correct structural invariants.
   - **INV4c boundary**: `>=` comparison means growth=1000 with threshold=1000 triggers nudge. Fixed `growthBelow` range to [0, 999].

7. Pipeline tests (INV6/INV7/BONUS) initially timed out with large inputs (50 msgs × 5000 tokens). Added `arbPipelineMsgCount` (3-15) and `arbPipelineMsgTokenSize` (100-1500) for pipeline tests.

8. INV7 initially failed because compress part was added to "last assistant message" which might be before the last user message (not in current turn). Fixed test fixture to ensure messages end with user → assistant(compress).

## Results

- **946 tests pass** (936 existing + 10 new property tests)
- **Total property test runtime**: 22.4 seconds
  - Pure function tests (INV1-INV5): <50ms
  - Pipeline tests (INV6/INV7/BONUS): 22.3s
- **Total random inputs tested**: ~1,400 across all properties
- **fast-check version**: 3.x

## Verification

- `npm run typecheck` — 0 errors
- `npm run test` — 946/946 pass
- `npm run build` — succeeds

## Key Insight

Property-based testing caught a real semantic misunderstanding during development (INV4 original invariant was wrong about the trigger policy). This demonstrates the value: even the test author's mental model can be wrong, and property-based testing surfaces the discrepancy automatically via counterexample shrinking.
