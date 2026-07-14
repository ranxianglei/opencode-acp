# WORKLOG — Visible-ID Segment Guidance

## Summary

Fixed the root cause of compress-tool failures reported in issue #9: the injected
visible-id guidance advertised a single contiguous span that crossed compression
holes, causing the model to pick already-consumed refs. Rewrote the guidance to emit
**disjoint segments** in ascending order, with bounded truncation when the segment
count exceeds a configurable cap.

## ChangeLog

| Commit    | File(s)                         | Change                                                                                                            |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| (this PR) | lib/config.ts                   | Add `CompressConfig.maxVisibleSegments` (default 50) + default + merge                                            |
| (this PR) | lib/config-validation.ts        | Allow `compress.maxVisibleSegments` key + type/range validation (>=1)                                             |
| (this PR) | dcp.schema.json                 | Add `maxVisibleSegments` property + default                                                                       |
| (this PR) | lib/messages/inject/inject.ts   | Rewrite `injectVisibleIdRange` → `buildVisibleSegments` + `formatVisibleGuidance` (pure, exported) + thin wrapper |
| (this PR) | tests/visible-segments.test.ts  | NEW — 17 unit tests: segment merge/sort/tool/tokens + format/truncate/order/K-suffix                              |
| (this PR) | tests/e2e-blocks-nudges.test.ts | Update visible-tag assertion to new `[Visible: … (N msgs, M segments)]` format                                    |

## KeyFiles

- `lib/messages/inject/inject.ts` — `buildVisibleSegments`, `formatVisibleGuidance`,
  `injectVisibleIdRange`, `VisibleSegment` interface (all exported for testability)
- `lib/config.ts` — `CompressConfig.maxVisibleSegments`, default, merge
- `lib/config-validation.ts` — key allowlist + validation
- `dcp.schema.json` — schema entry
- `tests/visible-segments.test.ts` — pure-function coverage
- `tests/e2e-blocks-nudges.test.ts` — integration assertion update

## DesignNotes

- Segments preserve **ascending ref order** in output (timeline clarity). Truncation
  picks the highest-value segments (`hasTool DESC, tokens DESC`) but re-projects them
  into ascending order for display.
- `hasTool` ranked first because tool-bearing segments are the prime compression
  targets; eliding them would hide exactly what the model needs.
- Token heuristic (`len/4`) is identical to `estimateContextComposition` so segment
  magnitudes stay consistent with the Breakdown line emitted in the same hook.
- Both new functions are pure → fully unit-testable without message/state mocking.

## Testing

- `tests/visible-segments.test.ts`: **17 pass** (segment build: empty/single/contiguous/
  hole/multi-hole/tool/tokens/skip-unmapped/ascending; format: empty/singular/plural/
  exactly-cap/over-cap/keep-tool/ascending-order/K-suffix).
- Full suite: **561 pass, 1 fail** — the 1 fail is the pre-existing bun-incompat in
  `prompts.test.ts` (nested `test()`), unrelated to this change.
- `tsc --noEmit`: clean.
- `tsup` build: success (348.72 KB).

## Risk

- **Low**. The change is isolated to one guidance string in the message-transform hook.
  No persisted-state format change. No tool-schema change. No search-logic change.
- Worst case if the new format confuses a model: it falls back to per-message mNNNNN
  refs (still injected by `injectMessageIds`) and asks `acp_status` — both still work.

## Lessons

- Ephemeral guidance strings that _describe_ state must stay consistent with the _actual_
  state, or the model trusts the description and mis-targets. A single "first–last" span
  was a latent lie once compression introduced holes.
- Extracting pure functions (`buildVisibleSegments`, `formatVisibleGuidance`) made the
  truncation/ordering edge cases trivially testable — worth the small refactor.

## Followups

- Consider promoting the `+N omitted` count into the periodic `[ACP] Context:` status
  line (prompts/system.ts:51) so the model sees segment density even outside nudges.
- If real sessions routinely exceed 50 segments, revisit the default cap with data.
