# REQ: Increase max tool compression candidates from 5 to 15

## Background

The context breakdown (shown when usage crosses the threshold) and the
tool-output reminder nudge both surface a list of "largest ranges" to the
model as compression candidates.

Before this change:

- `estimateContextComposition()` returned at most 10 message ranges and 5
  tool-output ranges.
- `injectCompressNudges()` sliced the top 5 from `largestRanges` when
  building the tool-output reminder.

Observation: the model was compressing too narrowly — frequently one
message per `compress` call — because only a handful of candidates were
visible at once. The compression philosophy in the system prompt asks the
model to cover "the largest range you can in a single call (aim for 20+
messages)", but the candidate list did not back that up.

## Requirement

Surface more compression candidates so the model can pick larger ranges:

1. `estimateContextComposition()`:
    - `largestRanges`: 10 → **15**
    - `largestToolRanges`: 5 → **15**
2. `injectCompressNudges()` tool-output reminder:
    - `topRanges`: 5 → **15**

Code and plain-text candidate lists (`largestCodeRanges`,
`largestMessageRanges`) stay at 5 — they are informational, not the
primary compression target.

## Scope

- `lib/messages/inject/utils.ts` (2 lines)
- `lib/messages/inject/inject.ts` (1 line)

No config, no persisted-state, no prompt-template changes.

## Why split from PR #80

This change was originally bundled into the `2026-07-09_summary-role-assistant`
branch (Bug 39: compression summary role). PR #80 is pending review and
cannot merge immediately, which blocks this independent improvement from
shipping. Splitting it into its own PR lets both move forward independently.

issue #13
