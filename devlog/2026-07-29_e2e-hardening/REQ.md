# REQ: E2E Hardening — Catch Bugs #235 and #236

## Problem

Bugs #235 (T2 nudge loop) and #236 (hide-consumed lastUserIdx guard) both slipped through the existing E2E test suite. Root cause: the E2E tests lacked:

1. **No nudge count verification** — only checked `nudgeBaselineSet` (boolean), not how many times nudge fired
2. **No T2-specific verification** — verify.ts only read `lastPerMessageNudgeTokens` (T1 baseline), never `lastTier2NudgeTokens`
3. **No consumed-call visibility check** — no way to verify that consumed compress calls were hidden from the LLM
4. **No negative assertions** — only checked "should happen happened", never "shouldn't happen didn't happen"

## Requirements

1. Add observation recording to fake-llm-server.ts — per-request metrics visible to verify.ts
2. Add new verify.ts assertions: `maxBlockCount`, `tier2BaselineSet`, `maxCompressCallsVisible`, `lastRequestCompressCalls`, `maxNudgeCount`, `activeBlockCount`
3. Add scenario 11 (T2 cadence regression — would catch #235)
4. Add scenario 12 (consumed-call hiding — would catch #236)
5. Harden scenarios 09 and 10 with upper bounds

## Success Criteria

- All 12 E2E scenarios pass
- Scenario 11 would fail if `lastTier2NudgeTokens` is reset to `undefined` after compress
- Scenario 12 would fail if consumed compress calls are left visible in context
