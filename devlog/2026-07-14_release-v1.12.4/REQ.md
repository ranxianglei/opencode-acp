# REQ: Release v1.12.4

## Version

1.12.3 → 1.12.4 (patch)

## Contents (PRs since v1.12.3)

- PR #132: Protection-aware compressible ranges and context stats
- PR #133: getCurrentTokenUsage accepts input-only token data (output=0 fix)
- PR #134: Inject compressible ranges when nudge anchors active + growth floor gate (anti-thrashing)
- PR #136: Support dev npm tag for prerelease publishing (CI only)

## Key changes

- `buildCompressibleRanges`, `estimateContextComposition`, `acp_status` skip protected tools/files
- Growth floor gate: nudges suppressed unless growth >= max(5000, 0.45 × nudgeGrowthTokens), with 98% emergency override
- `minCompressRange` default 2000 → 5000
- New config: `minNudgeGrowthRatio`, `minNudgeGrowthFloor`, `emergencyThresholdPercent`
- `getCurrentTokenUsage` accepts input-only token data (output=0)

## Verification

- TypeScript: pass
- Tests: 688 pass, 0 fail
- Build: success
