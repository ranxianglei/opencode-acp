# WORKLOG — Effective Compressible Accounting

## Changes

### lib/messages/inject/utils.ts
- `CompressibleRange`: added `effectiveTokens: number` field (docstring explains
  tokens vs effectiveTokens and references the incident).
- `buildCompressibleRanges`: tracks last user message index + per-message
  meaningful-content flag; computes `effectiveTokens` per message/group.
- `EFFECTIVE_MIN_COMPRESSIBLE_TOKENS = 1250` exported constant (aligned with
  `minCompressRange` 5000 chars ÷ 4).
- `filterRecommendedRanges`: drops sub-floor ranges; dangerous flag moves to the
  last SURVIVING range; logs dropped ranges in debug.
- `formatCompressibleRanges`: non-merged lines show "N effective of M" when they
  differ; merged entries' `compressibleTokens` now sourced from effective tokens.

### lib/messages/inject/inject.ts
- `nothingToCompress` gains `allBelowMin` (compressible > 0 but recommended = 0)
  → nudge silenced on squeezed contexts.

### tests/smart-nudge-gating.test.ts
- Updated tiny-ranges test to the new contract (sub-floor dropped).
- Added: floor boundary, retry-loop regression (10800 raw / 766 effective),
  all-sub-floor → empty, mixed keep/drop.

### tests/property-invariants.test.ts
- INV5 rewritten: every range ABOVE the floor is returned (no context-relative
  suppression — issue #251 intent preserved; floor is pipeline-absolute).

### tests/preserve-recent.test.ts
- Added: effectiveTokens excludes last user message; effectiveTokens excludes
  empty messages; incident reconstruction (floors 156-175) range not recommended;
  injectCompressNudges silent when all ranges sub-floor (mirrors the file's
  established baseline-preset pattern, growth gate passes via a large last user
  message).

## Verification

- typecheck: 0 errors
- tests: 1018 pass / 0 fail (was 1010 before the fix; +12 new, 2 rewritten)
- §5.7.3 surgical revert (floor disabled + allBelowMin=false): both incident
  regression tests FAIL; fix re-applied and suite green again.
- build: 881.32 KB sourcemap / dist built successfully.

## Update: config-derived floor (E2E fix + Oracle review finding)

E2E scenario 06-nudge-triggered failed (`blockCount >= 1 — got 0`): the E2E harness config sets
`minCompressRange: 0` (pipeline accepts any size), but the recommendation floor was hardcoded at
1250 — ranges dropped, nudge silenced, no compress. Same mismatch Oracle review flagged for user
configs that raise/lower `minCompressRange`.

- `resolveEffectiveFloor(config)` in utils.ts: floor = `minCompressRange ÷ 4` (÷4 chars/token), 0 when disabled
- `filterRecommendedRanges` takes `minEffectiveTokens` option; universal phantom guard `effective > 0` always applies
- inject.ts passes `resolveEffectiveFloor(config)`
- +3 tests (floor 0 passthrough, phantom guard at floor 0, raised floor)

Verification: typecheck clean, full suite green, E2E scenarios 06/09/10/11/12 pass locally (5/5).
