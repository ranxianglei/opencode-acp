# WORKLOG — decompress-source-availability (#446)

Branch: `2026-09-20_decompress-source-availability` · Base: master `026dbe73` · Date: 2026-09-20

## Summary

Fix for #446: block decompression reported `Restored N message(s)` and terminally
deactivated the summary block even when the indexed original messages were absent
from the host history. Root cause: the commit path treated a membership transition
(`activeBlockIds` going empty) as proof that content was restored, without ever
intersecting the required source IDs with the fetched history.

## Changes

| File | Change |
|------|--------|
| `lib/compress/decompress-logic.ts` | New `DecompressAvailabilityResult`, `collectRequiredDecompressMessageIds()`, `checkDecompressSourceAvailability()` |
| `lib/compress/decompress.ts` | Pre-commit availability gate in block/range decompress path (after toFile branch, before any state mutation); explicit missing-source error; warn log with refs |
| `tests/decompress-logic.test.ts` | 13 unit tests for the two new functions (tier semantics, closure, multi-target, empty membership) |
| `tests/decompress-source-availability.test.ts` | 9 E2E regressions through `createDecompressTool` with controllable host history: all-missing / ref-display / retry-after-abort / partial / complete / nested one-tier / nested full abort / nested full success / transient-fetch-failure rejection |
| `devlog/2026-09-20_decompress-source-availability/` | REQ.md + DESIGN.md + this file |

## Verification log

- [x] `npm run typecheck` — clean
- [x] `npm run test` — 1312/1314 pass (final state incl. post-review additions; one intermediate run showed a transient soft-block crash-count flake of `fail 3`, re-run stable at 2). The 2 failures are pre-existing environment issues, reproduced identically on clean master (verified by stashing this change):
      - `tests/soft-block.test.ts` — crashes at import: `EACCES mkdir '/tmp/opencode-dcp-dangerous-*'` (read-only `/tmp` in sandbox)
      - `E2E: toFile on inactive block writes block summary` — tool path validation rejects `/tmp` when `$TMPDIR` points elsewhere
- [x] `npm run build` — success (dist/index.js 488.57 KB)
- [x] Bug-detection proof (§5.7.3): gate temporarily removed → all-missing E2E test fails with `Decompressed block b5. Restored 1 message(s) (~100 tokens)` (the exact phantom-restoration behavior from the issue) → gate restored → 7/7 pass
- [x] Dual-agent review (§5.3 code + §5.6 tests) — two independent agents, both verdicts **approve-with-nits** (details below)

## Dual-agent review findings & disposition

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| C1 | One-tier nested commit does not verify the reactivated tier's summary-carrier compress message (carriers are hard-protected, never in `byMessageId`, so cannot enter R); if host history lost exactly the intermediate carrier, the topmost summary is terminally discarded with nothing usable restored | minor | **Documented as known limitation in DESIGN.md**; extending R with `compressMessageId`s changes R semantics beyond #446's stated scope and needs its own review |
| C2 | toFile path bypasses the gate by design but its success message under-counts silently when some indexed sources are absent | minor | Deferred — #445 owns the toFile field bugs; noted for that work |
| C3 | Untested branches: `deactivatedByUserDeep` exclusion from shielding; stale closure id; range-mode multi-target E2E | nit | deep-flag: covered indirectly by stricter `assert.equal(..., undefined)` on the abort path; stale-id + range-mode: unit-level coverage exists (closure tolerance, multi-target union), range E2E skipped as mode-agnostic (gate runs identically after target resolution) |
| C4 | BFS uses `queue.shift()` — O(k²) worst case | nit | No action: k = blocks under one target (small), runs once per tool call, never per LLM turn |
| T1 | No E2E pin of transient host-fetch failure (acceptance #6) | minor | **Fixed**: new test with rejecting client asserts `assert.rejects` out of the tool call + zero mutation |
| T2 | Ref-resolution display branch (`byRawId ?? raw`) untested — all fixtures had empty maps | minor | **Fixed**: new test seeds `byRawId`/`byRef` mapping, asserts `Missing: m00052.` (mappings verified to survive `assignMessageRefs`, lib/message-ids.ts:174-180) |
| T3 | Nested success tests didn't assert stats (acceptance #4) | nit | **Fixed**: one-tier success asserts `totalPruneTokens === 970` (3×10 restored), full success asserts `=== 950` (5×10 restored) |
| T4 | Weak deep-flag assertion (`!t1.deactivatedByUserDeep` passes for undefined and false) | nit | **Fixed**: `assert.equal(t1.deactivatedByUserDeep, undefined)` |
| T5 | `(+N more)` truncation untested (>10 missing IDs) | nit | Skipped: low value, string-format detail |

## Notes

- `npm run format` (Prettier) reformats ~350 unrelated repo files in this checkout (formatting drift vs. the committed tree). All unrelated rewrites were reverted; only the 4 PR-relevant source/test files carry changes. CI does not gate on `format:check`, so the drift is out of scope here.
- No version bump (release-branch-only rule). No state-format changes; purely additive API surface in `decompress-logic.ts`.
