# WORKLOG: Compression Format Prompt Rewrite (Issue #13)

## Summary

Rewrote the compression format guidance in `system.ts` with a concrete
KEEP-VERBATIM / DROP / PRIORITY taxonomy, and replaced the contradictory
EXHAUSTIVE-vs-LEAN guidance in `compress-range.ts` and `compress-message.ts`
with a concise pointer to the new system-prompt rules.

## Changes

### `lib/prompts/system.ts` (+31 net lines)

1. **Merged `BE FRUGAL` into `COMPRESSION PHILOSOPHY`** — removed the separate
   header, kept the batching guidance (20+ messages per call) inline. Avoids
   splitting "when to compress" advice across two sections.

2. **Trimmed `WHEN TO COMPRESS` bullets** — removed the inline preserve-hints
   (e.g. "compress the dead-ends but preserve the lessons learned"). Those
   hints now live canonically in HOW TO COMPRESS, so duplicating them in
   WHEN-TO bullets was noise. Bullets are now pure triggers.

3. **Added `HOW TO COMPRESS` section** with three prescriptive lists:

   - **KEEP VERBATIM** (7 concrete items): file paths+line numbers,
     function/class/type signatures, error messages+stack traces,
     decisions+rationale ("chose X over Y because Z"), constraints discovered,
     exact values, user intent (short messages quoted verbatim).
   - **DROP** (5 concrete items): verbose logs after error extraction,
     duplicate file reads, dead-end exploration (PRESERVE one-line lesson:
     "tried X, failed because Y"), back-and-forth after decision captured,
     repeated status checks.
   - **PRIORITY** (5-level ordering for space-constrained summaries):
     (1) user intent/acceptance criteria, (2) decisions+rationale,
     (3) exact technical artifacts, (4) conclusions/findings,
     (5) lessons learned.

   Closing line: "Write dense, scannable bullets — not narrative prose."

4. **Preserved `` render-placeholders** at L7 and L99 verbatim — these are
   filled at runtime by `prompts/index.ts` with actual tag names.

### `lib/prompts/compress-range.ts` (−4 net lines)

Replaced the EXHAUSTIVE + USER INTENT FIDELITY + LEAN trio with a single
concise paragraph that points to the HOW TO COMPRESS rules. Kept the
tool-specific mechanics unchanged: COMPRESSED BLOCK PLACEHOLDERS,
BOUNDARY IDS, BATCHING.

### `lib/prompts/compress-message.ts` (−4 net lines)

Same treatment as compress-range.ts. Kept MESSAGE IDS, BATCHING, GENERAL
CLEANUP sections and the minimal-summary-for-trivial-messages rule.

## Why Not PR #66

PR #66 reorganized `system.ts` into a 4-point structure
(What range covers / Critical content verbatim / What's recoverable / Why
omitted). The structure is reasonable but the content is abstract — it gives
no concrete lists of what "critical content" means, no taxonomy of what to
drop, and no priority ordering. The user judged it insufficient.

This change keeps the structural improvement (a dedicated HOW TO COMPRESS
section) but populates it with **prescriptive, concrete rules** the model can
actually follow, and propagates the same rules to the tool-level prompts.

## Verification

- `npm run typecheck` — PASS
- `npm run build` — PASS (dist/index.js, dist/index.d.ts emitted)
- `bun test tests/` — 575 pass, 1 fail (pre-existing, unrelated:
  `tests/prompts.test.ts:53` uses `test()` inside `test()` which Bun doesn't
  support; not caused by this change)

## Test Plan

- [x] Type check passes
- [x] Build succeeds
- [x] No test regressions caused by this change
- [ ] Manual deploy + verify the new prompt appears in the system prompt
- [ ] Manual compress in a real session, verify the summary follows
      KEEP/DROP/PRIORITY rules
