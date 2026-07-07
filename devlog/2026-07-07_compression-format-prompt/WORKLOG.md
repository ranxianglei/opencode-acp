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

   - **KEEP VERBATIM** (10 concrete items): file paths+line numbers,
     function/class/type signatures AND critical code lines, error messages+
     stack traces, report details (numbers+mechanism), decisions+rationale
     ("chose X over Y because Z"), constraints discovered, exact values,
     user intent (short messages quoted verbatim), open questions/unresolved
     TODOs, message refs of key anchors.
   - **DROP** (6 concrete items): verbose logs after error extraction,
     duplicate file reads, consumed exploration (search hits, agent results
     once facts extracted), dead-end exploration (PRESERVE one-line lesson:
     "tried X, failed because Y"), back-and-forth/self-corrections after
     final position captured, repeated status checks.
   - **PRIORITY** (5-level ordering for space-constrained summaries):
     (1) user intent/acceptance criteria/hard constraints, (2) decisions+
     rationale, (3) exact technical artifacts, (4) conclusions/findings,
     (5) lessons learned.

   Closing line: "Write dense, scannable bullets — not narrative prose."

4. **Preserved escaped backtick pairs** around tag names (e.g.
   `` `dcp-message-id` ``) at L7 and L103 verbatim — these are literal text
   in the template. `renderSystemPrompt()` in `prompts/index.ts` performs no
   substitution on `SYSTEM`; it only appends extensions.

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
- `node --import tsx --test tests/prompts.test.ts` — PASS (7/7). The env's
  `node` is a Bun wrapper; under Bun, `tests/prompts.test.ts:53` uses nested
  `test()` which Bun doesn't support, but this is an environment quirk, not
  a regression (the project's runner is Node per AGENTS.md §3.3).

## Test Plan

- [x] Type check passes
- [x] Build succeeds
- [x] No test regressions caused by this change
- [ ] Manual deploy + verify the new prompt appears in the system prompt
- [ ] Manual compress in a real session, verify the summary follows
      KEEP/DROP/PRIORITY rules

## Empirical Validation + Follow-up Tweaks

Reviewed a real compression produced under the OLD prompt:
**Compression #46** in session `ses_0cf8549c4ffeuOqKzr66BvRBmH`
(m01659→m01676, 14.2K removed → 929-token summary).

**Verdict**: the compression was high-quality — it already followed the
spirit of the new KEEP/DROP/PRIORITY rules (paths+line numbers verbatim,
exact values, decisions+rationale, verbose reasoning stripped to findings).

Two gaps surfaced vs. the new rules:

1. **Thematic grouping**: the summary grouped bullets under `###` headers
   (request → findings → root cause → decision), which scans better than
   flat bullets for a multi-concern range. The original closing line
   mandated "not narrative prose" — too restrictive. **Tweak**: allow
   thematic headers when the range spans distinct concerns.

2. **Message refs**: the summary preserved `m01659`, `m01667-m01669`, etc.
   as anchors for decompress navigation — useful but not in the KEEP list.
   **Tweak**: add message refs of key anchors to KEEP VERBATIM.

Both tweaks applied to `lib/prompts/system.ts`. Typecheck + build pass.
