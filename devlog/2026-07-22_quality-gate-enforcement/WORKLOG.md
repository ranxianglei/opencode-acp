# WORKLOG: Quality Gate Enforcement

## Implementation

### 1. State: `qualityGateRetryPending` flag
- `lib/state/types.ts`: Added `qualityGateRetryPending: boolean` to `SessionState`
- `lib/state/state.ts`: Initialize `false` in `createSessionState()` + reset `false` in `resetSessionState()`
- NOT persisted to disk — transient runtime flag. Resets on session restart (correct: model context also resets)

### 2. Config: threshold adjustment
- `lib/config.ts:259`: `layer1MinRetentionPct` default 1.0 → 5.0 (max ~20:1 ratio)

### 3. Pre-commit quality evaluation
- `lib/compress/quality-gate/evaluate.ts`: Added `evaluatePreCommitQuality()` function
  - Takes rawMessages, messageIds, messageTokenById, summary, config
  - Builds pseudo-block snapshot (compressedTokens estimated as sum of messageTokenById)
  - Overestimates compressedTokens → conservative (stricter) for blocking check
  - Returns null if quality gate disabled or no chunks extractable

### 4. Rejection error builder
- `lib/compress/quality-gate/rejection.ts`: New file
  - `buildQualityRejectionError()`: Severe error with stats + HOW_TO_COMPRESS rules + acknowledgeRisk instructions
  - `buildPreemptiveAcknowledgeError()`: Error for when acknowledgeRisk is used without pending rejection
  - Imports `HOW_TO_COMPRESS_RULES` from `context-compress-algorithms/prompts` (same as system prompt)

### 5. Range tool integration (`lib/compress/range.ts`)
- Added `acknowledgeRisk: boolean` to schema (no description — model discovers via rejection)
- Pre-commit check after `checkPhantomBlock`, before `snapshotCompressionState`:
  1. `acknowledgeRisk:true` + `!qualityGateRetryPending` → throw preemptive error
  2. `acknowledgeRisk:true` + `qualityGateRetryPending` → reset flag, skip quality
  3. No acknowledgeRisk → evaluate each plan, throw rejection on first failure

### 6. Message tool integration (`lib/compress/message.ts`)
- Same pattern as range tool

### 7. Types (`lib/compress/types.ts`)
- Added `acknowledgeRisk?: boolean` to `CompressRangeToolArgs` and `CompressMessageToolArgs`

### 8. Tests (`tests/quality-gate-enforcement.test.ts`)
- 10 tests: evaluatePreCommitQuality (5), buildQualityRejectionError (2), buildPreemptiveAcknowledgeError (1), state flag lifecycle (2)
- All 813 tests pass (803 existing + 10 new)

## Verification
- `tsc --noEmit`: clean
- `node --import tsx --test tests/*.test.ts`: 817 pass, 0 fail

## Dual-Agent Review Fixes

Two independent oracle agents reviewed the PR. Both converged on the same issues:

### Fix 1: Tautological test (BLOCKER)
Test "qualityGateRetryPending resets to false on resetSessionState" never called
`resetSessionState()` — manually set the flag to false then asserted false.
Fixed: now calls `resetSessionState(state)` directly and imports it.

### Fix 2: State-leak — flag never cleared on successful quality pass (WARNING)
If flag was `true` (from prior rejection) and model made a normal call (no
acknowledgeRisk) that passed quality, the flag stayed `true`. Model could then
"bank" the flag and use acknowledgeRisk on a totally different range to bypass
quality. Fixed: clear flag to `false` at the start of the quality-check else
branch in both range.ts and message.ts.

### Fix 3: Rollback bug — flag not restored on mutation failure (WARNING)
If acknowledgeRisk was consumed (flag→false) and then mutation failed inside
the try block, `restoreCompressionState` didn't restore the flag. Model was
stuck — couldn't retry with acknowledgeRisk (flag=false → preemptive error).
Fixed: save `qualityGateRetryPendingBefore` before quality processing, restore
it in the catch block alongside `restoreCompressionState`.

### Fix 4: Integration tests through createCompressRangeTool (WARNING)
Added 4 integration tests:
- Quality gate rejects bad summary through the full tool pipeline
- acknowledgeRisk bypasses quality after rejection (end-to-end retry flow)
- Preemptive acknowledgeRisk rejected without prior rejection
- Flag cleared on successful non-acknowledgeRisk compression (state-leak fix verification)

### Fix 5: buildConfig() missing required fields (WARNING)
Added all required CompressConfig fields: `autoUpdate`, `summaryBuffer`,
`minNudgeContextPercent`, `maxSummaryLengthHard`, `minCompressRange`,
`minNudgeGrowthRatio`, `minNudgeGrowthFloor`, `emergencyThresholdPercent`,
`maxVisibleSegments`, `keepEmbedMaxChars`.
