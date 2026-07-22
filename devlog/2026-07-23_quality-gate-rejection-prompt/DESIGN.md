# DESIGN - Quality-gate rejection recovery guidance

- Task ID: `2026-07-23_quality-gate-rejection-prompt`

## 1. Goal

Make the correct compression-rejection recovery path discoverable by the model,
so a non-adaptive model (e.g. glm-5.2) does not deadlock when the blocking
pre-commit quality gate rejects an oversized-range compression.

## 2. Data flow (unchanged)

```
compress(args) → validateArgs → prepareSession → resolveRanges
  → evaluatePreCommitQuality  ← BLOCKING gate (qualityGate.enabled)
      passed  → applyCompressionState → finalizeSession → commit
      FAILED → buildQualityRejectionError → THROW
                 state.qualityGateRetryPending = true
                 (model sees error text, must retry)
```

This PR does NOT change the flow. It only changes the **content** the model sees
at three points: the tool schema, the thrown error text, and the system prompt.

## 3. Changes

### 3.1 Tool schema — discoverable escape hatch

`lib/compress/range.ts` + `lib/compress/message.ts`: add `.describe(...)` to
`acknowledgeRisk`. The describe states (a) it overrides a rejection only, never
preemptive, (b) two better fixes to try first (split range / summaryMaxChars).

### 3.2 Rejection message — recovery path sized to the failure

`lib/compress/quality-gate/rejection.ts` `buildQualityRejectionError`:
introduce a "large range" branch using `originalTokens` (already computed in
`computeStats`).

- **Large range** (`originalTokens > 50000` OR `ratio > 50:1`): lead with
  **SPLIT** guidance — "break into 2-3 smaller contiguous ranges, compress each
  in the same batch call". A single dense summary is impractical at this size.
- **Small range**: keep the existing "write a denser summary" lead.
- **Both paths** additionally mention `summaryMaxChars` (raise the cap) and
  `acknowledgeRisk: true` (last resort). Keep the existing metrics block
  (Range / Original / Summary / Ratio / Retention / Gate layer / rougeF1 /
  top20Recall) and the appended `HOW_TO_COMPRESS_RULES`.

Threshold rationale: L1 floor is `retentionPct = summaryChars /
(originalTokens*4) >= 1%`, i.e. `summaryChars >= originalTokens*0.04`. At
50K tokens the dense minimum is already 2000 chars and grows linearly; by
~250K it exceeds 9000 chars — impractical for one summary. 50K is a sensible
"crossover" where splitting becomes the better advice.

### 3.3 System prompt — set expectations up front

`lib/prompts/system.ts`: add a "COMPRESSION REJECTION HANDLING" section (placed
after the tools / philosophy block, before PERIODIC CONTEXT STATUS). It states:
(1) compress can be rejected when qualityGate is on, (2) the three recovery
paths in priority order (split → denser/longer → acknowledgeRisk), (3) an
explicit anti-loop rule: after two rejections of the same range, change
strategy rather than resubmit an identical summary.

## 4. Backward compatibility

- No persisted-state field added/removed.
- No exported signature change. `buildQualityRejectionError(plan, result)`
  keeps the same signature; only its output text changes.
- No internal `dcp` tag touched.
- The blocking gate's pass/fail logic is untouched — only guidance text.

## 5. Testing

- Existing `tests/quality-gate-enforcement.test.ts` cases (1000-token small
  ranges) stay green: header, range, "1000 tokens", `acknowledgeRisk`,
  `HOW TO COMPRESS` all still present.
- New case: large range (>50K tokens) → message includes "split" advice.
- New case: small range → message keeps "denser" advice (regression guard).

## 6. Out of scope (follow-ups)

- Anti-deadlock counter: after N consecutive rejections of the same range,
  auto-downgrade to non-blocking. Requires a `qualityGateConsecutiveRejects`
  counter in `SessionState` → persistence migration. Separate PR.
- Making `qualityGate.enabled`'s blocking-vs-non-blocking behavior match the
  README (which only documents the non-blocking post-commit gate). Doc PR.
