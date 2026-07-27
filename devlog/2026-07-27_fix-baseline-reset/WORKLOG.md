# Worklog

## 2026-07-27

- Created branch `2026-07-27_fix-baseline-reset` from master `2a2aa07`
- Investigated root cause of subagent not triggering compression
  - Confirmed via context logs: 31 API calls, 719→142K growth, baseline at 132K
  - Identified feedback loop at `inject.ts:368-370` (baseline reset on nothingToCompress)
- Removed `lastPerMessageNudgeTokens = currentTokens` from nothingToCompress path
- Added 3 regression tests in `tests/baseline-reset.test.ts`
- typecheck + build + tests pass
