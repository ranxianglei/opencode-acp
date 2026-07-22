# REQ - Proportional Baseline Adjustment Tests

- Task ID: `2026-07-22_proportional-baseline-tests`
- Home Repo: `opencode-acp`
- Created: 2026-07-22
- Status: InProgress
- Priority: P0
- Owner: bot
- References: dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: ACP's nudge threshold has a proportional baseline adjustment mechanism (`lib/messages/inject/inject.ts:121-148`) that advances the baseline partially after a small compress, rather than fully resetting to post-compression tokens. This makes the next nudge fire sooner when the model only compressed a small portion of the growth.
- **Current behavior**: The proportional adjustment code IS wired up in production (hooks.ts:254 passes `prePruneTokens`), but ALL existing tests in `inject.test.ts` call `injectCompressNudges` without the 8th argument (`preCompressTokens`), so the proportional path never executes in tests.
- **Impact**: The most critical nudge mechanism — how the threshold slowly grows — is completely untested. Any regression in the proportional formula would go unnoticed.

## 2. Acceptance Criteria

- **Correctness**:
  - [x] Full compress (ratio ≥ 0.5) → full baseline push to postCompress
  - [x] Partial compress (ratio = 0.25) → half push
  - [x] Tiny compress (ratio = 0.1) → minimal push (20%)
  - [x] Over-compress (ratio > 1.0) → baseline drops below original
  - [x] growth = 0 → falls to else (baseline = postCompress)
  - [x] Multi-cycle: two sequential proportional compresses advance baseline correctly
  - [x] Voluntary compress (no nudge) skips proportional path
  - [x] compressBaselineSet lock prevents double-adjustment
  - [x] After proportional baseline, next nudge fires at correct threshold

## 3. Proposed Approach

- **Affected files**: NEW `tests/proportional-baseline.test.ts` (18 tests)
- **No changes to existing code** — tests only

## 4. Rollback Strategy

Single new test file — revert = delete file.
