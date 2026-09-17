# DESIGN - Nudge-armed compression

- Task ID: `2026-09-17_nudge-armed-compression`
- Status: Accepted

## Architecture

Current: nudge computes ranges → model calls `acp_status` → status recomputes and arms → model calls `compress`.

Proposed: nudge computes ranges → nudge arms and publishes exact bounds → model calls `compress`. `acp_status` continues to recompute and refresh on demand.

Both paths use `armBestSmartPlan`; `compress` still calls `validateSmartPlan`, preserving bounds, selected IDs, exact characters, structure version, visibility, and TTL.

Local policy raises `minCompressRange` to 80,000 characters and lowers growth thresholds to 20,000/15,000 tokens. This amortizes prompt-cache invalidation and acts earlier.

## Compatibility and rollback

Behavior remains gated by existing `smartPlanRequired`; its upstream default remains false. No persisted schema change. Roll back the source commit and restore the local thresholds.
