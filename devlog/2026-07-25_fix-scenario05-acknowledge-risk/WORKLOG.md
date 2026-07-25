# WORKLOG: Fix E2E scenario 05

## Investigation

User reported that PR #184 (per-session SessionState registry) "didn't pass" —
the E2E scenario 05 (subagent compress) was failing. Deep investigation:

1. **Ran scenario 05 on master** → 6 events (child ran), 1 child state file, 0 blocks. FAIL.
2. **Ran scenario 05 on #184** (without merged #192 infra) → 3 events (child couldn't run — `task` tool not whitelisted). FALSE PASS (childBlockCount assertion skipped).
3. **Merged master into #184** → 6 events, 1 child state file, 0 blocks. FAIL — same as master.
4. **Added ACP debug logging** to `hooks.ts` → confirmed child state IS in registry, `isSubAgent=true`, `assignMessageRefs` working (4 IDs assigned by last transform).
5. **Checked fake LLM log** → compress(m00001..m00003) was sent and a result was received (turn 5 proceeded).
6. **Queried opencode DB** → found the compress tool result: `status: error`, error message: `acknowledgeRisk provided but no quality gate rejection is pending`.

## Root Cause

`"acknowledgeRisk": true` in scenario 05's compress step. This flag is only
valid on retry after quality gate rejection. On first attempt, compress tool
rejects it. The compress never creates a block.

This bug was introduced in PR #192 and affects both master and #184 equally.
PR #184's per-session state is working correctly.

## Fix Applied

Removed `"acknowledgeRisk": true` from `scripts/e2e/scenarios/05-subagent-compress.json`.

## Files Changed

- `scripts/e2e/scenarios/05-subagent-compress.json` — removed `acknowledgeRisk: true` (1 line)
- `devlog/2026-07-25_fix-scenario05-acknowledgeRisk/REQ.md` — this requirement
- `devlog/2026-07-25_fix-scenario05-acknowledgeRisk/WORKLOG.md` — this worklog

## Verification

Both tested with `SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/05-subagent-compress.json`:

- **master** (c149686): PASS — `childBlockCount === 1` ✓
- **#184** (0d679c8 + master): PASS — `childBlockCount === 1` ✓
