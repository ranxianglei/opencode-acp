# WORKLOG - Skip nudge when filter has no recommendations

- Task ID: `2026-07-15_nudge-no-recs-skip`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-15 14:00

## 1. Summary

- **What was done**: Added `filterSuppressed` gate to skip nudge text injection when `filterRecommendedRanges` removes all ranges. Only suppresses when ranges exist but are filtered out — tests without message IDs (0 ranges) are unaffected.
- **Why**: Injecting "go compress" with an empty recommendation list confuses the model and wastes context.
- **Behavior / compatibility changes**: Yes — nudge text injection now depends on both `nudgeAllowed` AND (`hasRecommendations` OR `noRangesAtAll` OR `emergencyOverride`)
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (pending) | feat: skip nudge when filter has no recommendations |
| (pending) | test: adapt existing tests for recommendation filter gate |

### Key Files

- `lib/messages/inject/inject.ts` — Added `filterSuppressed` gate; moved range computation before nudge block
- `tests/inject.test.ts` — 2 new tests (suppressed + emergency); 3 tests with larger tool outputs
- `tests/e2e-blocks-nudges.test.ts` — 1 test with tool output added

## 3. Design & Implementation Notes

- **Entry point**: `injectCompressNudges()` in `lib/messages/inject/inject.ts`
- **Key logic**: `filterSuppressed = contextRanges.compressible.length > 0 && !hasRecommendations`
  - `compressible.length > 0` distinguishes "filter removed all" (suppress) from "no ranges at all" (don't suppress)
  - `shouldInject = nudgeAllowed && (!filterSuppressed || emergencyOverride)`
- **Filter thresholds**: Single range needs `tokens >= 3 × growthThreshold` to pass (floor + threshold = 3× growth)
  - 1M model: need ≥150K tokens → 600K+ chars tool output
  - 100K model: need ≥15K tokens → 60K chars tool output

## 4. Testing & Verification

### Test Coverage

- New test files: 0 (new tests added to existing files)
- Test count: 713 total, 713 pass, 0 fail
- Key scenarios verified:
  - Nudge suppressed when ranges exist but filtered out
  - Emergency override fires even without recommendations
  - Existing tests pass with adapted tool output sizes

### Results

- **PASS**: 713/713 tests, typecheck 0 errors, build 399KB
