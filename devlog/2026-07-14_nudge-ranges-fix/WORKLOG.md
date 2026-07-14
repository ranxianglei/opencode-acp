# WORKLOG: Growth floor gate for compress nudges (anti-thrashing)

## Branch

`2026-07-14_nudge-ranges-fix` (from `master`)

## Evolution

### Commit 1 (PR #134 original): Show ranges when anchors active

Fixed the "compress prompt without ranges" bug by broadening the breakdown
condition to `shouldNudge || hasActiveNudgeAnchors`.

### Commit 2 (this update): Growth floor gate

Replaced the multi-condition gate with a single `nudgeAllowed` based on
growth floor. This prevents over-compression thrashing after PR #134 removed
the growth cadence protection for the `overMinLimit` path.

## Changes

### `lib/config.ts`

- Added `minNudgeGrowthRatio: number` (default 0.45) to `CompressConfig`
- Added `minNudgeGrowthFloor: number` (default 5000) to `CompressConfig`
- Added `emergencyThresholdPercent: number | \`${number}%\`` (default "98%")
- Changed `minCompressRange` default: 2000 → 5000
- Added merge logic for all three new fields

### `lib/config-validation.ts`

- Added all three new fields to `VALID_CONFIG_KEYS`
- Added type + range validation:
    - `minNudgeGrowthRatio`: number in [0, 1]
    - `minNudgeGrowthFloor`: non-negative number
    - `emergencyThresholdPercent`: number | "${number}%" (inlined check)

### `dcp.schema.json`

- Added property definitions for `minCompressRange`, `minNudgeGrowthRatio`,
  `minNudgeGrowthFloor`, `emergencyThresholdPercent`
- Updated defaults section

### `lib/messages/inject/inject.ts`

- Moved `nudgeGrowthTokens` computation before `applyAnchoredNudges`
- Added `resolveEmergencyThreshold()` helper function
- Added growth floor computation:
    ```typescript
    const growthFloor = Math.max(
        config.compress?.minNudgeGrowthFloor ?? 5000,
        (config.compress?.minNudgeGrowthRatio ?? 0.45) * nudgeGrowthTokens,
    )
    ```
- Added `emergencyOverride` check (context >= emergency threshold)
- Added `nudgeAllowed = emergencyOverride || growth >= growthFloor`
- Replaced `shouldInjectThisTurn = decision.shouldNudge` → `nudgeAllowed`
- Added `effectiveTipsVariant` (forces "maxLimit" on emergency override)
- Gated `applyAnchoredNudges` behind `nudgeAllowed`
- Replaced `if (decision.shouldNudge || hasActiveNudgeAnchors)` → `if (nudgeAllowed)`
- Removed nested `if (decision.shouldNudge)` — flattened into `if (nudgeAllowed)`
- Changed save condition from `decision.shouldNudge` → `nudgeAllowed`

### `tests/inject.test.ts`

- Updated `buildConfig()` to include all new config fields
- Replaced PR #134 regression test with 4 new growth floor tests:
    1. **Suppressed**: 5K growth < 22500 floor (1M model) → no output
    2. **Fires**: 25K growth >= 22500 floor → breakdown + ranges
    3. **Emergency**: 98% context, 0 growth → override fires + strong alert
    4. **5000 floor**: 100K model, 4K < 5000 suppressed, 6K >= 5000 fires

## Verification

- TypeScript: pass.
- Tests: **688 pass**, 0 fail.
- Build: success.

## Risk

Medium. This changes the nudge firing behavior: previously (PR #134) nudges
fired whenever anchors were active; now they require growth >= floor (or 98%
emergency). This is the intended anti-thrashing behavior. Configurable via
`minNudgeGrowthRatio`, `minNudgeGrowthFloor`, `emergencyThresholdPercent`.
