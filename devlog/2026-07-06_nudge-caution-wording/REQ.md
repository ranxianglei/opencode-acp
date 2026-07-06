# REQ — Nudge Caution & Efficiency Wording

## Background

Issue #9 follow-up: two prompt-wording refinements to the per-message nudge breakdown
(injected by `injectCompressNudges` in lib/messages/inject/inject.ts when `shouldNudge`).

## Problem

1. **Over-compression of large ranges**: the breakdown lists the largest tool/code/text
   ranges with token counts, then said only "compress the largest consumed ranges first".
   The model sometimes read "largest" as the compression target and compressed a range
   purely because it was big — even when the current step still needed its full content.

2. **Growth-nudge misread as overflow**: the breakdown shows `(+X since last nudge)`.
   Without context, the model could read a large growth delta as "context is about to
   overflow" and compress rashly. The growth nudge is actually an **efficiency** prompt
   (compress early to stay lean); a separate, stronger alert fires at maxLimit.

## Acceptance Criteria

- [x] After listing the largest ranges, the guidance tells the model that size alone is
      not a reason to compress — ranges still needed in full must stay.
- [x] Soft nudges (growth / minLimit) carry an explicit "efficiency nudge, not overflow"
      clarification, pointing to the separate stronger alert at maxLimit.
- [x] The maxLimit path (already has its own "Context limit reached" warning) does NOT
      duplicate the efficiency note.
- [x] No persisted-state, tool-schema, or API change.
- [x] `tsc --noEmit` clean; full suite green (modulo known pre-existing bun-incompat).

## Approach

- Add an `efficiencyNote` string prepended to the breakdown when
  `decision.tipsVariant !== "maxLimit"`.
- Move the `💡 Compress incrementally …` line to AFTER the largest ranges list (so the
  model sees the data first, then the guidance), and reword it to distinguish "consumed"
  from "still needed".
