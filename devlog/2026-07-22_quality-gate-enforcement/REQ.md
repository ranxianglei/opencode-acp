# REQ: Quality Gate Enforcement — Blocking Pre-Commit Check

## Problem

The quality gate is non-blocking: it logs warnings but never rejects bad compressions.
This allowed block b7 in session `ses_07fa6ea18ffe7FVkta5UpKd2Jr` to compress 7598 tokens
into 353 chars (94 tokens, 81:1 ratio) — a meta-reference summary with zero standalone value.

Three-layer failure:
1. L1 retention threshold too low (1.0% allows 99:1 ratio)
2. L2 AND logic (both rougeF1 AND top20Recall must fail — keyword overlap passes)
3. Non-blocking (quality gate only logs, never rejects)

## Solution

### 1. Pre-commit blocking quality gate
Move quality evaluation from post-commit (in `finalizeSession`) to pre-commit
(before `applyCompressionState`). Reject the compression if quality fails.

### 2. `acknowledgeRisk` parameter
Add `acknowledgeRisk: boolean` to compress tool schema (both range + message mode).
- NOT documented in schema description — model discovers it only via rejection error
- Only valid after a prior rejection for this range (tracked via `state.qualityGateRetryPending`)
- Preemptive use (no prior rejection) → error "remove this parameter"
- One-shot: consumed on use, next call goes through quality gate normally

### 3. Severe error message
Rejection error includes:
- Stats (original tokens → summary chars, ratio, retention%)
- Severe warning about data loss and context chain collapse
- Full HOW TO COMPRESS rules (same as system prompt)
- Instructions to add `acknowledgeRisk: true` on retry

### 4. Threshold adjustment
Raise `layer1MinRetentionPct` default from 1.0% to 5.0% (max ~20:1 ratio).

## Scope

Files to change:
- `lib/state/types.ts` — add `qualityGateRetryPending: boolean` to SessionState
- `lib/state/state.ts` — initialize flag in `createSessionState` + `resetSessionState`
- `lib/config.ts` — raise `layer1MinRetentionPct` default 1.0 → 5.0
- `lib/compress/quality-gate/evaluate.ts` — add `evaluatePreCommitQuality`
- `lib/compress/quality-gate/rejection.ts` — new: build severe rejection error
- `lib/compress/quality-gate/index.ts` — export new function
- `lib/compress/range.ts` — add `acknowledgeRisk` to schema + pre-commit check
- `lib/compress/message.ts` — add `acknowledgeRisk` to schema + pre-commit check
- `lib/compress/types.ts` — add `acknowledgeRisk` to tool args types
- `tests/quality-gate-enforcement.test.ts` — new test file

## Non-persisted state

`qualityGateRetryPending` is a transient runtime flag — NOT persisted to disk.
Resets to `false` on session restart. This is correct because the model's context
also resets on restart, so there's no pending rejection to retry.
