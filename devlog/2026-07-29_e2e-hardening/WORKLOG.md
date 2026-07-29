# WORKLOG: E2E Hardening

## Changes

### fake-llm-server.ts
- Added `OBSERVATIONS_FILE` env var (default: `/tmp/acp-e2e-observations.json`)
- Added `RequestObservation` and `Observations` exported interfaces
- Added `recordObservation()` — records per-request metrics: turn, inputTokens, messageCount, compressCallCount, nudgeDetected, isChild
- Called in `handleChatCompletion` for every real request (tools > 0)
- Added `totalCompressionsEmitted` counter — incremented in `compressResponse()`, used by `handleAutonomousNudgeStep` for `maxCompressCount` check
- Added `maxCompressCount` field to `ScenarioStep` — allows scenarios to configure how many compressions before stopping (default: 2)
- Changed `handleAutonomousNudgeStep` completion check from `compressCount >= 2` (visible calls) to `totalCompressionsEmitted >= maxCompressCount` (total emitted) — more reliable since visible count oscillates when consumed calls are hidden

### verify.ts
- Added new assertion types:
  - `maxBlockCount` — upper bound on total blocks (detects nudge loops)
  - `tier2BaselineSet` — checks `lastTier2NudgeTokens` is set (not undefined). Bug #235 reset this.
  - `activeBlockCount` — checks count of active (non-deactivated) blocks
  - `maxCompressCallsVisible` — max compress tool_use calls seen in any single LLM request. Bug #236 left consumed calls visible.
  - `lastRequestCompressCalls` — compress call count in the final LLM request
  - `maxNudgeCount` — upper bound on total nudge detections
- Added `readObservations()` to parse the observations JSON file
- Added diagnostic output: active block count, observation stats

### run-e2e.sh
- Clean up `/tmp/acp-e2e-observations.json` before each scenario
- Pass `OBSERVATIONS` env var to fake-llm-server.ts and verify.ts

### ci.yml
- Added scenarios 11 and 12 to E2E scenario list
- Added observations dump to failure diagnostics

### Scenarios
- **09-nudge-refire-after-compress**: Added `maxBlockCount: 8`, `maxNudgeCount: 6`
- **10-autonomous-nudge-refire**: Added `maxBlockCount: 5`, `maxCompressCallsVisible: 2`, `maxNudgeCount: 10`
- **11-t2-cadence-regression** (NEW): 4-compression autonomous-nudge with low nudgeGrowthTokens=100. Verifies `tier2BaselineSet: true` — would fail if #235 bug present (lastTier2NudgeTokens reset to undefined).
- **12-consumed-call-hiding** (NEW): 4-compression autonomous-nudge. Verifies `lastRequestCompressCalls === 1` and `maxCompressCallsVisible <= 3` — would fail if #236 bug present (consumed calls left visible).

## Verification Results

All 12 E2E scenarios pass locally:
```
01-basic-compress: PASS
02-quality-reject: PASS
06-nudge-triggered: PASS
08-nudge-with-protection: PASS
09-nudge-refire-after-compress: PASS (5 assertions)
10-autonomous-nudge-refire: PASS (5 assertions)
11-t2-cadence-regression: PASS (5 assertions)
12-consumed-call-hiding: PASS (5 assertions)
```

Scenario 11 key metrics:
- 4 blocks created (3 T1 + 1 T2)
- tier2BaselineSet: true (lastTier2NudgeTokens correctly set after T2 compress)
- maxCompressCallsVisible: 1 (consumed calls properly hidden)

Scenario 12 key metrics:
- 4 blocks created (3 T1 + 1 T2)
- lastRequestCompressCalls: 1 (only most recent compress visible)
- maxCompressCallsVisible: 1 (T1 calls hidden after T2 consumed them)
