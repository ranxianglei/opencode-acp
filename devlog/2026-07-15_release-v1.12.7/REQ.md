# REQ: Release v1.12.7

## Goal

Release smart recommendation filter + dangerous parameter + deploy version guard.

## Changes (from PR #142, merged)

1. **filterRecommendedRanges rewrite**: Last segment < 2× growth → excluded; ≥ 2× → included with `dangerous: true`. Gate: effective compressible = non-last + max(0, last − 2× floor); suppress all if < growth threshold. Protected ranges no longer affect filtering.

2. **Dangerous parameter**: Stateless `dangerous?: boolean` on compress tool schema. Replaced state-tracking soft-block (`lastSegmentConfirmAttempts`). Net −70 lines.

3. **Debug filter decision**: `sendIgnoredMessage` injects filter reasoning into chat (model-invisible, user-visible when `debug: true`). Also logged to daily debug log.

4. **dev-deploy.sh version guard**: Auto-bumps deployed version above npm latest to prevent overwrite on restart.

## Version

1.12.6 → 1.12.7
