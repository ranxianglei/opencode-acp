# REQ: Suppress Nudge When All Content Is Protected

## Problem

When a user configures high-frequency tools (e.g., `read`) in `compress.protectedTools`,
most or all context becomes non-compressible. The nudge system still fires based on total
token growth (including protected content), creating false-positive nudges with nothing to
compress — wasting a model turn.

PR #147's `filterSuppressed` only handles the case where compressible ranges exist but are
filtered out. When `compressible.length === 0` (all protected), `filterSuppressed = false`,
and the nudge fires uselessly.

## Fix

Add `allProtected` check: when `compressible.length === 0 && protected.length > 0`, suppress
the nudge (emergency override still bypasses). This distinguishes "all protected" from
"no refs assigned yet" (where both arrays are empty).

## Acceptance Criteria

- [x] Nudge suppressed when all content is protected
- [x] Emergency override (98% context) still fires when all content is protected
- [x] Existing `filterSuppressed` behavior unchanged
- [x] All tests pass
