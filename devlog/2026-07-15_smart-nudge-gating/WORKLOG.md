# WORKLOG: Smart Nudge Gating

## 2026-07-15

### Implementation

1. **State infrastructure** — Added `lastSegmentConfirmAttempts: Set<string>` to `Nudges` interface. Initialized in `createSessionState`, `resetSessionState`, `resetOnCompaction`. Persisted as `string[]` in `PersistedNudges`.

2. **Config** — Added `lastSegmentSoftBlock?: boolean` to `CompressConfig`, default `true` in defaults, merged in `mergeCompressConfig`. Allows tests to bypass the soft-block.

3. **Soft-block pipeline** — `getLastVisibleMessageId(rawMessages, state)` scans backward for the first non-synthetic, non-pruned message. `checkLastSegmentSoftBlock(ctx, planMessageIds, rawMessages)` returns an Error if any plan covers the last visible message and it hasn't been confirmed yet. State is saved before throwing so the retry succeeds. Integrated in both `range.ts` and `message.ts` after `minCompressRange` check, before the compression loop.

4. **Recommendation filtering** — `filterRecommendedRanges(compressible, protected, options)` applies two layers:
   - Per-range: drop single-message ranges unless tokens > 5× growth threshold
   - List-level: suppress all when protected-dominated (unless huge range exists)
   Integrated in `inject.ts` before `formatCompressibleRanges`.

5. **Tests** — 15 pure-function tests in `smart-nudge-gating.test.ts`, 5 integration tests in `soft-block.test.ts`. Updated 6 existing test files to set `lastSegmentSoftBlock: false` in `buildConfig()` or enlarge test data.

### Verification
- TypeScript: 0 errors
- Build: dist/index.js 397KB
- Tests: 708/708 pass (688 existing + 20 new)
