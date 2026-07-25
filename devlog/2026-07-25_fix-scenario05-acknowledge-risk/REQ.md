# REQ: Fix E2E scenario 05 — remove erroneous acknowledgeRisk on first compress

## Problem

E2E scenario `05-subagent-compress.json` sets `"acknowledgeRisk": true` on the
**first** compress call inside the subagent. This parameter is only valid when
**retrying** after a quality gate rejection. On a first attempt, the compress
tool correctly rejects it:

```
Parameter "acknowledgeRisk": true was provided, but no quality gate rejection
is pending. This parameter is only valid immediately after a compression was
rejected by the quality gate. Remove it and try again.
```

This causes the child session to produce **0 blocks**, making the test fail on
both master and PR #184.

## Root Cause

PR #192 (`test: E2E scenario for subagent compression`) introduced scenario 05
with `acknowledgeRisk: true` at the top level of the compress step — likely
copy-pasted from scenario 03 without realising scenario 03 nests it inside
`retryOnReject`.

## Fix

Remove `"acknowledgeRisk": true` from the compress step in scenario 05. The
initial compress call should not carry this flag.

## Verification

- Scenario 05 passes on **master** (c149686): `childBlockCount === 1` ✓
- Scenario 05 passes on **#184** (0d679c8 + master merge): `childBlockCount === 1` ✓
