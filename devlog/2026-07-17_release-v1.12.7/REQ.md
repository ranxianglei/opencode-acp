# REQ: Release v1.12.7 (stable)

## Goal

Promote v1.12.7-dev.1 to stable, shipping the smart nudge gating + phantom turn + ref-leak fixes.

## Changes (4 PRs since v1.12.6)

1. **PR #142 — Smart recommendation filter + `dangerous` parameter**
   - `filterRecommendedRanges` rewrite: last segment < 2× growth → excluded; ≥ 2× → included with `dangerous: true`. Gate: effective compressible = non-last + max(0, last − 2× floor); suppress all if < growth threshold.
   - Stateless `dangerous?: boolean` on compress tool schema (replaced state-tracking soft-block, net −70 lines).

2. **PR #147 — Nudge-no-recs-skip**
   - Suppress nudge text injection when `filterRecommendedRanges` returns no recommendations.

3. **PR #149 — Debug-no-phantom-turn (filter decision to logger)**
   - Filter decision: `debugNotify` → `logger.debug()` (fires every transform hook → was phantom-turn source).

4. **PR #150 — Stop ref-leak + phantom turn (toast) + review fixes**
   - Stop leaking `mNNNNN` refs in block metadata (`range` → `messageCount` across `prune.ts`, `utils.ts`, `recap.ts`, `status.ts`, `notification.ts`, `system.ts`).
   - `debugNotify` callback: `sendIgnoredMessage` → `client.tui.showToast()` + `logger.debug()` (transient, non-persisting — kills phantom turn feedback loop at the source).
   - Singular grammar (`1 msg` vs `1 msgs`).
   - Dual-agent review by 2 oracle agents; findings addressed.

## Version

1.12.7-dev.1 → 1.12.7
