# REQ: Compression Format Prompt Rewrite (Issue #13)

## Problem

ACP tells the model **when** to compress (WHEN TO COMPRESS, BE FRUGAL, triggers)
but not **how** to format the summary. The existing guidance is contradictory:

- `compress-range.ts` says the summary "must be EXHAUSTIVE — EVERYTHING"
- then immediately says "be LEAN — strip away the noise"

Without a concrete KEEP-vs-DROP taxonomy, the model compresses arbitrarily:
sometimes too terse (losing file paths, decisions, error text), sometimes too
verbose (preserving boilerplate, repeated reads, dead-end reasoning).

PR #66 attempted to fix this by reorganizing `system.ts` into a 4-point
"HOW TO COMPRESS" section. The reorganization is fine structurally, but the
content is abstract ("capture critical content verbatim") — it gives no
concrete lists of what to keep, what to drop, or how to prioritize when
space-constrained. The user judged it insufficient ("写的超级烂").

## Root Cause

1. **No KEEP taxonomy**: The model is told to be "exhaustive" without a
   checklist of what "exhaustive" means (paths, signatures, errors, decisions,
   constraints, exact values, user intent).

2. **No DROP taxonomy**: The model is told to be "lean" without a checklist of
   what constitutes noise (verbose logs after extraction, duplicate reads,
   dead-end exploration, back-and-forth, repeated status checks).

3. **No priority ordering**: When the summary must be compact, there is no
   guidance on what to preserve first (user intent > decisions > artifacts >
   findings > lessons).

4. **Contradictory adjectives**: "EXHAUSTIVE" and "LEAN" pull in opposite
   directions without a rule to resolve the tension.

## Acceptance Criteria

1. `system.ts` gains a **HOW TO COMPRESS** section with:
   - A clear KEEP-VERBATIM list (concrete items: paths, signatures, errors,
     decisions+rationale, constraints, exact values, user intent quotes).
   - A clear DROP list (concrete items: logs after extraction, duplicate reads,
     dead-ends with lesson preserved, back-and-forth, repeated status checks).
   - A PRIORITY ordering for space-constrained summaries.
2. `compress-range.ts` and `compress-message.ts` have the contradictory
   EXHAUSTIVE/LEAN guidance replaced with a pointer to the HOW TO COMPRESS
   rules, keeping only tool-specific mechanics (boundary IDs, batching,
   placeholders).
3. The empty `` render-placeholder pairs in `system.ts` (L7, L72) are
   preserved verbatim — they are filled at runtime by `prompts/index.ts`.
4. No logic changes — prompt text only. No new dependencies.
5. `npm run build`, `npm run typecheck`, and `npm run test` all pass.
6. Existing tests are not regressed.

## Constraints

- Prompt text changes only. No behavioral or structural code changes.
- Keep system.ts token footprint reasonable — the HOW TO COMPRESS section must
  be concrete but not bloated.
- Do not change internal `dcp` XML tag naming (backward compat — AGENTS.md §2.6).
- Follow AGENTS.md commit/devlog/PR workflow.
