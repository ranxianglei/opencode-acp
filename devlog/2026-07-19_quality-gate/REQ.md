# REQ - Pluggable Compression Quality Gate

- Task ID: `2026-07-19_quality-gate`
- Home Repo: `opencode-acp`
- Created: 2026-07-19
- Status: InProgress
- Priority: P1
- Owner: awork (bot)
- References: dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: Calibration research on 6913 real compression blocks (issue #20) showed that ~3.3% of all summaries retain <1% of original content — catastrophic quality failures. Some pass length checks but still miss all key content (rougeF1 < 0.01 at 5-8% retention).
- **Current behavior (symptom)**: ACP happily accepts 147-char summaries of 72K-token original ranges; the model loses critical content silently.
- **Expected behavior**: A pluggable quality-gate framework evaluates each block post-compression; failures emit a non-blocking warning (do NOT reject the compression — the model already committed to it).
- **Impact**: Detect bad summaries early so future model calls can self-correct, and surface the issue for human review.

## 2. Reproduction (if applicable)

- **Environment**: All sessions. Worst case `ses_096cf8c43ffecAx2ProIeW6KHS` block b27: 72K tokens → 147 chars (0.05% retention), 0/20 top keywords covered.
- **Minimal reproduction steps**:
  1. Run any long session
  2. Inspect blocks via `acp-inspect <sid> --blocks`
  3. Look for summaries < 200 chars or with content coverage near zero

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: existing configs must keep working (qualityGate section is optional, defaults to disabled-or-defaults)
  - Performance: gate runs ONCE per compress call, not per transform hook. Must be < 10ms for typical blocks.
  - No new runtime dependencies (tokenizer is hand-rolled, no nltk/bert).
  - TypeScript strict mode, ESM, no `as any`.
- **Non-Goals** (explicitly out of scope for THIS iteration):
  - External API gate (HTTP call to LLM judge) — interface must ALLOW it, but not implemented now
  - Auto-rejection of bad compressions (only warn + log)
  - Auto-decompression of bad blocks (future iteration)
  - Multilingual tokenization beyond EN + ZH (future)

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `QualityGate` interface defined with `name`, `evaluate(ctx)` returning `{ passed, layer?, reason?, metrics? }`
  - [ ] Registry: `registerQualityGate(gate)`, `getQualityGate(name)`
  - [ ] Default algorithm `rouge-recall-v1` implements Layer 1 (length) + Layer 2 (rougeF1 AND top20Recall)
  - [ ] Config schema supports `qualityGate.enabled`, `qualityGate.algorithm`, `qualityGate.algorithms["rouge-recall-v1"]`
  - [ ] `pipeline.finalizeSession` calls the active gate for each block, logs warning on failure
  - [ ] Failed gates do NOT block compression or throw
- **Performance / Stability**:
  - [ ] Gate evaluation < 10ms for 50K-token original + 3K-char summary
  - [ ] Tokenizer allocates no unnecessary intermediate strings
- **Regression**:
  - [ ] New tests: tokenizer, gate logic, registry, pipeline integration
  - [ ] All 599 existing tests pass
  - [ ] Type check + build pass

## 5. Proposed Approach

See `DESIGN.md` for the full architecture.

- **Affected modules & entry files**:
  - New: `lib/compress/quality-gate/` (tokenizer.ts, types.ts, registry.ts, algorithms/rouge-recall-v1.ts, index.ts)
  - Modified: `lib/config.ts` (add `qualityGate` config + merge logic), `lib/config-validation.ts` (add keys)
  - Modified: `lib/compress/pipeline.ts` (call gate in `finalizeSession`)
  - Modified: `dcp.schema.json` (add schema for new config keys)
- **Risks**:
  - Gate false-positives annoy users — mitigated by conservative thresholds (rougeF1<0.05 AND top20<0.20 = 6.6% FPR)
  - Tokenizer ZH coverage — mitigated by combining ZH unigrams + bigrams
- **Rollback strategy**: Set `qualityGate.enabled = false` in config. No persisted state changes.
