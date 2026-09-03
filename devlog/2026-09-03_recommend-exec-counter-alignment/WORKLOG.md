# WORKLOG: Align nudge recommendation-side and compress execution-side character counting (Issue #359)

**Branch**: `2026-09-03_recommend-exec-counter-alignment`
**Issue**: https://github.com/ranxianglei/opencode-acp/issues/359 (source: #355 analysis; same family as #37 incident ses_7fb5cbc8)
**Date**: 2026-09-03

## Changes

| File | Change |
|------|--------|
| `lib/messages/inject/utils.ts` | `buildCompressibleRanges` now sizes every message with `Math.round(countMessageCharacters(msg) / 4)` in BOTH branches (compressible ~line 811, protected ~line 785). Per-part loops retained only for classification (`isTool`, `toolPct`, `hasMeaningfulPart`) and protected tool-name collection. Merged the two `../../token-utils` imports into one (added `countMessageCharacters`). One-line invariant comment at each fixed site. |
| `tests/recommend-exec-counter-alignment.test.ts` | NEW — 7 regression tests (see below). |
| `devlog/2026-09-03_recommend-exec-counter-alignment/REQ.md` | Ticket written BEFORE implementation. |

No changes to `filterRecommendedRanges`, `resolveEffectiveFloor`, `CompressibleRange` shape,
grouping logic, soft-filter mirroring, zone sizing, or any display-only counter
(`estimateContextComposition`, `computeProtectedRefs`, notification stats) — see REQ non-goals.

## Tests

New file `tests/recommend-exec-counter-alignment.test.ts` (7 tests):

1. pure-text message: rec-side tokens === exec-side `countMessageCharacters ÷ 4` (exact)
2. pure-text: new counter identical to pre-fix estimator (guards against over-correction)
3. completed tool (object input + multiline string output): rec == exec, legacy estimator provably overstated
4. error-state tool (multi-line stack trace): rec == exec, legacy overstated
5. deeply nested JSON object output (8 levels × 5 items): rec == exec, legacy overstated
6. incident shape (#355 v1.14.26, min 3000): 4-message tool-heavy span with exec total
   2866 chars < 3000 but pre-fix inflated estimate 780 ≥ floor 750 → post-fix DROPPED by
   `filterRecommendedRanges`; counterfactual synthetic range with the legacy estimate is KEPT
   (pins both sides of the regression)
7. protected branch: protected-range `tokens` also use the shared counter

### Verification (§5.7.3 — tests must fail against buggy code)

Surgical revert (`git stash push lib/messages/inject/utils.ts` → run → `git stash pop`):

- **Pre-fix code: 5/7 FAIL** (all tool-shape tests + incident + protected branch); the 2
  pure-text tests PASS by design (old counter agreed for text) — proves the suite targets
  exactly this bug with no false positives.
- **Post-fix: 7/7 PASS.**

Full gate results (post-fix):

| Gate | Result |
|------|--------|
| `npm run typecheck` | ✅ clean |
| `npm run test` (full suite) | ✅ **1069/1069** (was 1062; +7 new) |
| `npx prettier --check` on changed files | ✅ test file + REQ/WORKLOG clean |

Formatting note: `lib/messages/inject/utils.ts` carries 70 lines of PRE-EXISTING prettier
drift (part of 421 repo-wide unformatted files on master). Verified via normalized diff
(prettier under `.prettierrc` on HEAD vs worktree) that my hunks introduce ZERO new drift —
only the intended logical changes remain after normalization. Left un-reformatted to keep
the PR diff minimal; repo-wide format cleanup is out of scope.

## Fixture-tuning notes (lesson learned)

The incident fixture must satisfy two constraints simultaneously: exec total < 3000 AND
pre-fix inflated estimate ≥ 750 tokens. For this message shape the inflation gap
(legacy − exec) is nearly constant (~256 chars — wrapper fields + escaping density), so the
feasible window is exec ∈ [~2744, 3000). Final constants: 16 stack frames, 20 body
paragraphs, 105-char summary → exec = 2866 (margin 134), legacy = 780 (margin 30). Both
constraints are asserted dynamically in-test, so any future fixture edit that breaks them
fails loudly instead of silently weakening the regression pin.

Residual divergence after the fix: per-message rounding keeps multi-message ranges within
±0.5 tokens/message (≤ 2 chars/msg) of the pipeline's whole-range char sum — asserted as a
rounding band in test 6, orders of magnitude below the pre-fix 10–40% systematic bias.
A strict `CompressibleRange.chars` field (acp-kernel style) was considered and deferred
(REQ non-goals) to keep the public range shape stable; revisit only if sub-band precision
ever matters.
