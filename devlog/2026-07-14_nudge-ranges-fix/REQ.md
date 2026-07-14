# REQ: Nudge ranges fix — show compressible ranges when nudge anchors active

## Problem

When context usage crosses `minContextLimit` (e.g., 20%) but growth since last nudge
is below `nudgeGrowthTokens` (adaptive, ~6K–50K), the anchored nudge prompt text
("Context is getting full...") is injected via `applyAnchoredNudges`, but the
detailed breakdown — including the **compressible ranges list** — is NOT injected
because `computeShouldNudge` returns `false`.

Result: the model sees "compress now" but has no list of ranges to target.

## Root Cause

`injectCompressNudges` (`lib/messages/inject/inject.ts`) has two disconnected nudge
injection paths:

1. **Anchored nudges** (`applyAnchoredNudges`, L228): injects nudge prompt text when
   `overMinLimit` or `overMaxLimit`. NOT gated by growth cadence.

2. **Detailed breakdown** (`if decision.shouldNudge`, L274→L284): injects context
   usage stats + compressible ranges list + block guidance. Gated by growth cadence
   (`computeShouldNudge`).

When growth < `nudgeGrowthTokens` and `!overMaxLimit`, path 1 fires but path 2 doesn't.

## Fix

Broaden the detailed breakdown condition from `decision.shouldNudge` to
`decision.shouldNudge || hasActiveNudgeAnchors`. The growth cadence still controls:
- `maxLimit` strong alert text
- `lastNudgeShownTokens` baseline update
- Block aging guidance

## Acceptance Criteria

- When `overMinLimit` is true and nudge anchors are active, compressible ranges
  list is always injected (even if growth < nudgeGrowthTokens).
- Growth-based cadence (`computeShouldNudge`) still controls maxLimit tips and
  `lastNudgeShownTokens`.
- Existing tests for growth cadence continue to pass.
- New test: verify ranges injection when `overMinLimit && !shouldNudge`.
