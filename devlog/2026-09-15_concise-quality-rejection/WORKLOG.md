# WORKLOG - Concise quality-gate rejection message

- Task ID: `2026-09-15_concise-quality-rejection`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15

## 1. Summary

- **What was done**: Slimmed the quality-gate rejection error returned to the
  model. Removed the embedded `HOW_TO_COMPRESS_RULES` (~1,234 tokens) and the
  multi-line "⚠️ CRITICAL" warning paragraph; added the gate `reason` line
  (previously unused); rewrote retry guidance into three sentences with an
  accurate description of the `acknowledgeRisk` escape hatch.
- **Why**: Issue #396 — every rejected compression re-injected ~5.4K chars of
  mostly redundant text into the model's context (the full rules already live
  in the system prompt, `lib/prompts/system.ts:58`), defeating the purpose of
  compression in long sessions.
- **Behavior / compatibility changes**: Yes, cosmetic only — the rejection
  payload text changes; the blocking gate, its config, metrics, and the
  throw/bypass mechanics in `lib/compress/range.ts` are untouched. The E2E
  fake-LLM marker strings ("COMPRESSION REJECTED", "QUALITY GATE FAILURE")
  remain present in the header.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `3d8688f` | fix: concise quality-gate rejection message (no rules re-injection) |
| `6dd1860` | test: address round-1 review finding (assert retry directive) |
| `a242578` | fix: precise acknowledgeRisk window wording (next compress call) |

### Key Files

- `lib/compress/quality-gate/rejection.ts` — dropped `HOW_TO_COMPRESS_RULES`
  import/embedding + CRITICAL paragraph; added `Reason:` line from
  `result.reason`; compact retry guidance (rewrite + retry; rules already in
  system prompt; `acknowledgeRisk: true` bypasses once).
- `tests/quality-gate-enforcement.test.ts` — fixture extracted into
  `buildRejectionFixture()`; old "should include compress rules" assertion
  inverted to absence assertions ("HOW TO COMPRESS" / "KEEP VERBATIM" /
  "CRITICAL"); reason inclusion asserted; new <1,000-char size-budget
  regression guard. Integration tests unchanged.

## 3. Design & Implementation Notes

- **Entry point / key function**: `buildQualityRejectionError(plan, result)`
  in `lib/compress/quality-gate/rejection.ts`; single throw site
  `lib/compress/range.ts:351`.
- **Key logic explanation**: the message keeps header + range + 8 metric lines
  (reason, original tokens, summary chars, ratio, retention, gate layer,
  rougeF1, top20Recall) + one retry paragraph. Pre-fix payload ≈ 5.4K chars
  (≈1.4K tokens); post-fix ≈ 600 chars (≈150 tokens) for a standard rejection
  — ~85% smaller.
 - **acknowledgeRisk wording fix**: the old text claimed "Without
   acknowledgeRisk: true, the compression will be rejected again", which is
   false under #301/#303 semantics — a rewritten summary that passes the gate
   is accepted without the flag; the flag only bypasses when
   `qualityGateRetryPending` is set (i.e., after a prior rejection). Round-1
   code review further refined the window: `qualityGateRetryPending` is cleared
   at the start of *every* compress call (`lib/compress/range.ts:338`), so the
   bypass window is exactly the next compress call — final text says "bypass
   the quality gate on your next compress call" (commit `a242578`). (Full
   interaction redesign remains open in #339.)

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/quality-gate-enforcement.test.ts
npm run build
npm run test
```

### Test Coverage

- New/modified test files: `tests/quality-gate-enforcement.test.ts`
  (+2 tests: absence-of-rules, size budget; 1 test rewritten)
- Test count: 1,133 total, 1,133 pass, 0 fail (full suite)
- Key scenarios verified:
  - Rejection message contains header, range, reason, stats, acknowledgeRisk
  - Rejection message does NOT contain HOW TO COMPRESS / KEEP VERBATIM /
    CRITICAL (regression guard for this exact bug)
  - Message length < 1,000 chars (regression guard vs pre-fix ~5.4K)
  - Ratio/retention computation unchanged
  - Integration: real-tool rejection path, acknowledgeRisk bypass, #301
    preemptive no-op, flag cleared on success — all green

### Dual-Agent Review (AGENTS.md §5.3 / §5.6)

- **Code review (independent agent)**: APPROVE. Verified typecheck clean,
  15/15 + full 1133/1133 green, backward-compat (signature/interface/barrel,
  E2E marker strings intact, no other module imports the removed constant),
  no state mutation, diff clean. One NIT: `acknowledgeRisk` bypass window is
  exactly the next compress call (`qualityGateRetryPending` cleared at
  `range.ts:338`) → wording fixed in `a242578`.
- **Test review (independent agent)**: APPROVE. Import correctness, name
  fidelity, fixture completeness, input validity all pass; no tautologies or
  local reimplementation. Mutation check performed: swapped in `master`'s
  rejection.ts → the 3 new/changed tests FAILED as expected (missing reason,
  rules re-embedded, 5811 chars > budget); restored → 15/15 pass, tree clean.
  Two NITs: added `Retry:` assertion (`6dd1860`); size-budget magic number kept
  with an explanatory comment (acceptable regression guard).

### Results

- **PASS/FAIL**: PASS
- **Key logs/data**: `# tests 1133 / # pass 1133 / # fail 0`

## 5. Risk Assessment & Rollback

- **Risk points**: none identified — text-only change; single call site; E2E
  markers preserved.
- **Rollback method**: revert commit(s) `3d8688f`, `6dd1860`, `a242578`; no
  state or API impact (text-only change).
- **Compatibility notes** (data format, config schema): None.

## 6. Lessons Learned (optional)

- Error payloads returned to the model are context cost — any content that
  already lives in the system prompt must never be duplicated into tool
  errors.
- The repo's prettier baseline is not clean (430 files flagged at HEAD); only
  new/changed lines were kept conformant to avoid unrelated diff noise
  (same convention as `2026-09-09_custom-storage-path`).

## 7. Follow-ups (optional)

- [ ] Advisory mode / auto-bypass after N consecutive rejections — open
      design discussion in #339 (owner decision pending).
- [ ] `dangerous` parameter residue cleanup — tracked in #339.
