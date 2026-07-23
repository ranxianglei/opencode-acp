# REQ - Quality-gate rejection: tell the model the correct recovery path

- Task ID: `2026-07-23_quality-gate-rejection-prompt`
- Home Repo: `opencode-acp`
- Created: 2026-07-23
- Status: InProgress
- Priority: P1
- Owner: awork
- References: dog/opencode-acp#33

## 1. Background & Problem Statement

- **Context**: `qualityGate.enabled: true` activates a **blocking pre-commit**
  quality gate (`evaluatePreCommitQuality` in `lib/compress/quality-gate/evaluate.ts`,
  wired in `lib/compress/range.ts`/`message.ts`). A summary that fails the gate
  throws `buildQualityRejectionError` and the compression does not commit.
- **Current behavior (symptom)**: In session `ses_07fa6ea18ffe...` (issue #33),
  glm-5.2 tried to compress a ~243K-token range into an 8543-char summary
  (0.88% retention, L1 floor is 1%). The gate rejected it 23 times. Each
  rejection re-billed ~320K tokens and injected ~15KB of error text. The model
  never used the `acknowledgeRisk` escape hatch (0/23) and never split the range.
  Result: context stuck at ~320K, ~millions of tokens billed for zero progress.
- **Expected behavior**: After a rejection, the model must be able to discover a
  *correct* recovery path. The three valid paths are: (1) split an oversized
  range into smaller ranges, (2) write a denser / longer summary (raise
  `summaryMaxChars`), (3) `acknowledgeRisk: true` as last resort.
- **Impact**: Deadlock for non-adaptive models → token blowup + unusable
  compression when `qualityGate.enabled` is on.

## 2. Root Cause (prompt-chain audit)

Three gaps make the correct recovery path undiscoverable:

1. **Tool schema** (`lib/compress/range.ts:91`, `lib/compress/message.ts:66`):
   `acknowledgeRisk: tool.schema.boolean().optional()` has **no `.describe()`**
   (sibling fields `dangerous` and `summaryMaxChars` do). The model cannot learn
   what the parameter does from the tool definition.
2. **Rejection message** (`lib/compress/quality-gate/rejection.ts:42-75`): tells
   the reason (metrics) + mentions `acknowledgeRisk`, but the only recovery hint
   is "rewrite a more complete summary" — wrong/impossible for a 243K-token
   range (would need ≥9725 chars). Never advises **splitting** the range, never
   mentions `summaryMaxChars`.
3. **System prompt** (`lib/prompts/system.ts`): completely silent on the fact
   that compression can be rejected and how to recover. The model has no prior
   expectation of rejection.

## 3. Constraints & Non-Goals

- **Constraints**:
  - No `as any` / `@ts-ignore` (AGENTS.md).
  - Backward compatible: no persisted-state format change, no internal `dcp`
    tag rename (AGENTS.md §2.6).
  - L1 gate contract unchanged — we only improve *guidance text*, not the gate
    thresholds.
  - Follow existing code style (double quotes, no semicolons, 4-space indent).
- **Non-Goals (this PR)**:
  - Anti-deadlock auto-downgrade after N consecutive rejections (needs a state
    counter → schema change). Tracked as a follow-up.
  - Changing gate thresholds or the blocking-vs-non-blocking design.
  - Touching the external `context-compress-algorithms` package.

## 4. Acceptance Criteria

- [ ] `acknowledgeRisk` has a `.describe()` in both `range.ts` and `message.ts`.
- [ ] `buildQualityRejectionError` gives **split-range** guidance when the range
      is large (>50K tokens, absolute count — ratio intentionally excluded so a
      small-but-terse range still gets denser-summary advice), and keeps
      denser-summary guidance for small ranges. Both paths mention
      `summaryMaxChars` + `acknowledgeRisk`.
- [ ] `system.ts` has a "COMPRESSION REJECTION HANDLING" section listing the
      three recovery paths in priority order, and an explicit "do not loop"
      rule.
- [ ] New test asserts large-range guidance mentions splitting.
- [ ] Existing tests in `tests/quality-gate-enforcement.test.ts` still pass.
- [ ] `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`
      all pass.
