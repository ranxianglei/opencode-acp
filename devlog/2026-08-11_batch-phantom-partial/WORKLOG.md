# WORKLOG: partial-failure batch compress + phantom diagnostics (issue #290)

## Root cause

`lib/compress/pipeline.ts` `checkPhantomBlock` validated each batch entry and
returned an `Error` on the FIRST phantom plan. `lib/compress/range.ts` threw on
that error, aborting the ENTIRE batch — the remaining valid entries were never
executed. The error named the entry index but not the conflicting message IDs
or owning blocks, forcing trial-and-error retries. Separately,
`lib/compress/search.ts` `clampMessageRef` silently clamped beyond-last-visible
refs, which could shift boundaries onto consumed ranges.

Verified call sites:
- `checkPhantomBlock` was called once, at `lib/compress/range.ts:280`.
- `clampMessageRef` is invoked from `resolveBoundaryIds` (start + end).
- `checkPhantomBlock`'s contract is covered by `tests/phantom-block.test.ts`
  (must keep returning `Error | null` with `/range N/i`, `/already-compressed/`,
  `/0 new direct messages/`).

## Fix

### A + C. Partial-failure batches with diagnostics — `lib/compress/pipeline.ts`

1. Extracted the per-plan loop into `identifyPhantomPlans(state, plans)` →
   `{ phantomIndices: number[], details: PhantomPlanDetail[] }`. Each detail
   carries `{ index, consumedMessageIds (sample of 8), owningBlockIds (sorted) }`.
   Preserves the multi-consumed single-tier carve-out and the "new iff
   activeBlockIds empty" rule (mirrors `applyCompressionState`).
2. `buildPhantomErrorMessage(details)` renders a multi-entry message listing
   `Entry N`, consumed IDs sample, owning `bN` block refs, and a stale-ref
   fallback for empty owning sets.
3. `checkPhantomBlock` now delegates to `identifyPhantomPlans` and renders the
   legacy single-error string (first phantom only) — exact backward-compat
   contract preserved, existing tests pass unchanged.

### A. Batch caller — `lib/compress/range.ts`

Replaced the `checkPhantomBlock` throw with:
- `identifyPhantomPlans` runs BEFORE `snapshotCompressionState`/apply (ordering
  invariant: dropped entries must leave no ghost blocks).
- ALL phantom → `throw buildPhantomErrorMessage(details)` (verbose diagnostics
  — entry index + consumed IDs + owning blocks — so the model can correct).
- SOME phantom → filter them out, `ctx.logger.warn(...)` with full details,
  and a CONCISE skip notice in the success return (one line: which entry
  numbers were dropped + "no-ops, remaining compressed"). Verbose diagnostics
  stay only on the all-fail throw; the success path is warn-flavored, not a
  verbose dump (per reviewer direction: "warn 最好").

### B. Clamp warning — `lib/compress/search.ts`

`resolveBoundaryIds` now takes an optional `logger` and emits
`compress startId/endId mNNNNN not available — clamped to mNNNNN` when
`clampMessageRef` shifts a boundary. Threaded through `resolveRanges`
(`lib/compress/range-utils.ts`); `range.ts` passes `ctx.logger`. The logger is
optional + structural so existing callers (`rebuild.ts`, `decompress.ts`) and
pure unit tests need no changes.

D (unify nudge judging) explicitly out of scope — the reporter confirmed the
nudge list is already correct; ghost IDs that appear there are genuinely
compressible individually.

## Tests — `tests/phantom-block.test.ts`

11 new tests, all asserting real behavior (no tautologies):
- `identifyPhantomPlans`: empty when all new; reports owning block + consumed
  IDs; reports ALL phantoms in a mixed batch (not just first); keeps the
  single-tier carve-out; treats deactivated (GC'd) msgs as new; dedups owning
  blocks.
- `buildPhantomErrorMessage`: includes Entry N + bN + already-compressed;
  lists multiple entries; handles stale-ref (empty owning) case.
- `checkPhantomBlock` delegation preserved (both branches).

Verified the bug→fix relationship: the partial-failure path
(`phantomId.phantomIndices.length < preparedPlans.length`) only exists because
`identifyPhantomPlans` returns ALL phantoms rather than short-circuiting on the
first — the old `checkPhantomBlock` could not express "skip these, keep those".

## Verification

- `npx tsc --noEmit` → 0 errors.
- `node --import tsx --test tests/*.test.ts` → 968 pass / 0 fail (was 957;
  +11 new).
- `npm run build` → dist/index.js 390 KB, success.
- Bundle grep: `identifyPhantomPlans` (2), `phantomSkipNotice` (4),
  `clamped to` (4) — all fixes present in shipped bundle.
- `prettier --check` on 5 changed files → clean.

## Files changed

- `lib/compress/pipeline.ts` — `identifyPhantomPlans`, `buildPhantomErrorMessage`,
  `checkPhantomBlock` delegate, `PhantomPlanDetail`/`PhantomIdentification` types.
- `lib/compress/range.ts` — partial-failure batch logic + skip-notice return.
- `lib/compress/search.ts` — optional logger warn on clamp.
- `lib/compress/range-utils.ts` — thread optional logger through `resolveRanges`.
- `tests/phantom-block.test.ts` — 11 new tests.
