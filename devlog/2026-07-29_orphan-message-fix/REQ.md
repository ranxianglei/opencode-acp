# REQ: Splice orphan messages after consumed compress part removal

## Problem

When `hideConsumedCompressCalls` removes the compress tool-call part from an
assistant message whose block was consumed by a higher-tier compression, the
message may survive with only structural parts (step-start, step-finish,
reasoning). These orphan messages waste context tokens (~500-2000 each) with
zero useful content.

Root cause: `hideConsumedCompressCalls` checked `remaining.length > 0` to decide
whether to keep the message. Structural parts count as "remaining" even though
they carry no meaningful content. `dropEmptyMessages` also does not catch them
because it only considers text-only-empty/ignored messages as empty.

## Fix

After removing the compress tool part, check whether the remaining parts contain
any meaningful content (text, tool, file, anything not in the structural set).
If only structural parts remain, splice the message entirely.

## Files

- `lib/compress/hide-consumed.ts` — added `STRUCTURAL_PART_TYPES` set and
  `hasMeaningfulContent` check
- `tests/hide-consumed.test.ts` — 4 new tests
