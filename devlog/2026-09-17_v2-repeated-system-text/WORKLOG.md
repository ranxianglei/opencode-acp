# WORKLOG - Map Repeated Identical V2 System Text by Ordered Occurrence

- Task ID: `2026-09-17_v2-repeated-system-text`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-17 13:05

## 1. Summary

- **What was done**: Removed the premature multi-candidate rejection in the system
  branch of `normalizeV2ProjectedHistory`'s draft->outgoing-index mapping. System
  sources now correlate by ordered occurrence via the existing greedy
  `outgoingSystem(...)` claiming helper; no other rejection path changed.
- **Why**: OpenCode's lowering emits system messages without IDs, so N identical
  projected system records produce N identical ID-less lowered messages. The old
  code treated that valid host sequence as ambiguity and rejected the whole
  projection, which skipped pruning/ID/nudge injection and blocked fresh session
  initialization from committing state.
- **Behavior / compatibility changes**: Yes — previously-rejected sessions with
  repeated identical system text are now accepted and mapped in order. Persisted
  state schema, config schema, internal `dcp-*` tags, and all non-system rejections
  are unchanged.
- **Risk level**: Low — the claiming behavior is identical to before for every
  previously-valid case; only the rejection was removed.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| branch `2026-09-17_v2-repeated-system-text` | fix(v2): map repeated identical system text by ordered occurrence (code + tests + devlog) |

### Key Files

- `lib/v2/projection/normalize.ts` — replaced the `candidates.length > 1` rejection
  block in the system branch with a direct ordered-occurrence call to
  `outgoingSystem(stringValue(draft.source.text) ?? "", outgoingSystemIndicesByText, claimedMessages)`.
- `tests/v2-context-patch.test.ts` — added 5 unit tests: repeated identical text
  maps by ordered occurrence; interleaved histories preserve per-text order; extra
  host-added duplicates stay unclaimed; host-added foreign text stays unclaimed;
  ambiguous patchable (non-system) sources still reject.
- `tests/v2-context.test.ts` — added an end-to-end test asserting a fresh registry
  commits and accepts a direct compression when history repeats identical system text.
- `devlog/2026-09-17_v2-repeated-system-text/{REQ.md,WORKLOG.md}` — this entry.

## 3. Design & Implementation Notes

- **Entry point / key function**: `normalizeV2ProjectedHistory(projected, outgoing, options)`
  in `lib/v2/projection/normalize.ts`, specifically the loop that assigns each draft
  its `outgoingMessageIndices`.
- **Key logic explanation**: For each projected record, the code picks one lowered
  outgoing index to claim. Non-system records correlate by ID (`outgoingById`).
  System records correlate by text because lowering drops IDs. The helper
  `outgoingSystem(text, map, claimed)` scans the indices list for that text from the
  start and returns the first index not already claimed, marking it claimed. Because
  projected records are processed in source order, the k-th record of a given text
  naturally claims the k-th unclaimed lowered match — correct ordered correlation
  with no explicit bookkeeping. Removing the pre-check rejection is therefore safe:
  every previously-valid projection still produces byte-identical mappings, and the
  previously-rejected cases now proceed through the same already-correct claiming.
  A record whose text has no remaining lowered match simply stays unmapped; its
  normalized origin is opaque, so it never triggers the patchable-origin rejection.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build
node --import tsx --test tests/*.test.ts
node --import tsx --test tests/v2-context-patch.test.ts tests/v2-context.test.ts
npx tsc --noEmit
```

### Test Coverage

- New/modified test files: `tests/v2-context-patch.test.ts`, `tests/v2-context.test.ts`.
- Key scenarios verified:
    - Repeated identical system text -> ordered mapping, `valid: true`, both opaque.
    - Interleaved repeated texts -> second occurrence maps to second lowered match.
    - Extra host-added system messages (duplicate + foreign) -> unclaimed, no reject.
    - Ambiguous patchable non-system source -> still rejects (fail-closed guard).
    - E2E: fresh registry commits + direct compression reachable on committed state.
- Fail-on-bug verification: temporarily reverted the fix and confirmed the 3 new
  "should now be valid" unit tests AND the e2e test FAIL against the pre-fix code
  (e2e fails at `assert.ok(run.registry.get("session"))`, the exact #422 symptom),
  then restored the fix.

### Results

- **PASS/FAIL**: PASS (see full-suite run).
- **Key logs/data**: `tests/v2-context-patch.test.ts` 29/29 pass; new e2e passes on
  the fix and fails on the reverted code.

## 5. Risk Assessment & Rollback

- **Risk points**: None beyond mapping-order correctness; guarded by ordered
  occurrence tests and the fail-closed non-system guard.
- **Rollback method**:
    - Revert commit(s): the single fix commit on branch `2026-09-17_v2-repeated-system-text`
    - Rollback impact: restores the previous reject-on-repeated-system-text behavior.
- **Compatibility notes** (data format, config schema): No — persisted state schema,
  config schema, and internal `dcp-*` tags unchanged.

## 6. Lessons Learned

- A helper that already implements the desired algorithm made the fix a pure
  deletion of a wrong early-exit rather than new logic — worth confirming existing
  helpers before adding code.
- Verifying new regression tests against the reverted bug (revert-and-run) caught
  that two of the "host-added" scenarios were positive controls passing in both
  states, so they were kept specifically as guards, not as the primary repro.

## 7. Follow-ups

- [ ] Dual-agent review of the modified test files per AGENTS.md §5.6.
