# WORKLOG: Fix E2E Tests

## Changes

### `scripts/e2e/run-e2e.sh`
- Extracted hardcoded `acp.jsonc` into `write_acp_config()` function
- Added per-scenario config override: reads `acpConfig` field from scenario JSON, writes it as the config for that scenario
- Default config unchanged (all protection disabled) — backward compatible with existing scenarios

### `scripts/e2e/verify.ts`
- Added `compressedCount`, `minCompressedCount`, `maxCompressedCount` to `VerifyExpectations`
- Added `getCompressedMessageIds()` — reads `prune.messages.byMessageId` keys (the compressed message set)
- These checks verify that protection actually filtered messages, not just that compress succeeded

### `scripts/e2e/scenarios/07-protection-filtered.json` (NEW)
- Production config: `preserveRecentMessages: 5, preserveLastUserMessage: true`
- 8 text turns (infrastructure topics) + compress "all"
- Verifies: `blockCount: 1` (compress succeeded, soft-filter not hard-reject) + `maxCompressedCount: 14` (at least some messages protected)
- Would FAIL on pre-v1.14.2 code (hard-reject → `blockCount: 0`)

### `scripts/e2e/scenarios/08-nudge-with-protection.json` (NEW)
- Production config: `preserveRecentMessages: 5, preserveLastUserMessage: true`
- 5 `nudge-compress` turns with large growth text
- Verifies: `minBlockCount: 1` (compress succeeded) + `nudgeBaselineSet: true` (baseline not reset) + `maxCompressedCount: 10` (protection working)
- Tests the exact bug scenario from PR #207/#210/#212

### `.github/workflows/ci.yml`
- Added scenarios 05, 06, 07, 08 to the E2E job

### `scripts/e2e/README.md`
- Updated scenario table with scenarios 07 + 08
- Documented `acpConfig` field and new verify fields

## Verification

- Build: ✅ (454 KB bundle)
- Typecheck: ✅ (0 errors)
- Unit tests: ✅ (922/922 pass)
- E2E local: ✅ (8/8 scenarios pass)
  - 01-basic-compress: 1 block ✅
  - 02-quality-reject: 0 blocks ✅
  - 03-quality-acknowledge: 1 block ✅
  - 04-batch-compress: 3 blocks ✅
  - 05-subagent-compress: parent 0 + child 1 ✅
  - 06-nudge-triggered: 1 block + baseline set ✅
  - 07-protection-filtered: 1 block + compressedCount ≤ 14 ✅
  - 08-nudge-with-protection: 1 block + baseline set + compressedCount ≤ 10 ✅
