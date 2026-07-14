# WORKLOG — Nudge Caution & Efficiency Wording

## Summary

Two prompt-wording refinements to the per-message nudge breakdown in `injectCompressNudges`
(lib/messages/inject/inject.ts), requested in issue #9. (1) Added a "size ≠ compress"
caution after the largest-ranges list so the model keeps ranges still needed in full.
(2) Prefixed soft nudges with an efficiency-vs-overflow clarification so the
`(+X since last nudge)` growth indicator is not misread as an overflow warning.

## ChangeLog

| File                          | Change                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lib/messages/inject/inject.ts | `efficiencyNote` prepended to breakdown when `tipsVariant !== "maxLimit"`; `💡 Compress incrementally …` line moved to after the largest ranges and reworded to distinguish consumed-vs-still-needed |

## KeyFiles

- `lib/messages/inject/inject.ts` (breakdown block inside `injectCompressNudges`, ~lines 226-254)

## DesignNotes

- **Gating**: `decision.tipsVariant !== "maxLimit"` selects soft nudges (growth / minLimit).
  The maxLimit path already emits its own strong "⚠️ Context limit reached — compress now"
  warning (line ~256), so the efficiency note is suppressed there to avoid contradiction.
- **Ordering**: moved the `💡 …` guidance to AFTER the largest ranges so the model reads
  the data first, then the framing. Previously it appeared between Top blocks and the
  largest ranges.
- **Wording**: "target the ranges above whose content you have already extracted for this
  step. Size alone is not a reason to compress — if a large range is still needed in full,
  keep it." — directly addresses the over-compression failure mode.

## Testing

- `tsc --noEmit`: clean.
- Full suite: **544 pass, 1 fail** — the 1 fail is the pre-existing bun nested-`test()`
  incompat in `prompts.test.ts`, unrelated.
- `tsup` build: success (345.96 KB).
- No new test added: the change is prompt wording only. The gating logic
  (`tipsVariant !== "maxLimit"`) is trivially verifiable by reading the code, and pinning
  exact wording in a test would defeat the purpose (wording is meant to iterate).

## Risk

- **Very low**. Ephemeral guidance string only; no state, schema, or API change. Worst
  case if wording underperforms: iterate on the text.

## Lessons

- When listing "largest" items as compression candidates, the adjective "largest" alone
  can be read as a directive. Guidance must explicitly separate "consumed" (compressible)
  from "large" (not a criterion).
- A growth indicator without a semantic frame gets read as a threat. Labeling the nudge
  type (efficiency vs overflow) up front reframes the delta correctly.

## Followups

- Observe in real sessions whether the efficiency note reduces rash mid-task compression.
- If the maxLimit overflow warning also needs wording polish, handle in a separate change.
