# REQ: Fix E2E Tests — Not "形同虚设"

## Problem

The Docker E2E tests (`scripts/e2e/`) had severe gaps that made them ineffective at catching real bugs:

1. **ALL protection disabled in E2E config** — `preserveRecentMessages: 0, preserveRecentTokens: 0, preserveLastUserMessage: false`. The protection mechanism fixed 3 times (PR #210/#211/#212) was completely untested.

2. **CI ran only 4/6 scenarios** — scenarios 05 (subagent) and 06 (nudge-triggered) existed but were NOT included in the CI `run-e2e.sh` invocation.

3. **Would NOT catch recent bugs**:
   - Baseline-reset (PR #207): only triggers with `preserveRecentMessages > 0`
   - Giant group (PR #210): only in autonomous sessions
   - Hard-reject protection (PR #212): E2E disabled all protection

4. **verify.ts too shallow** — only checked `blockCount`. No verification of which messages were compressed vs protected.

5. **No Docker** — despite AGENTS.md §5.7.2 calling them "Docker E2E tests", no Dockerfile existed.

## Requirements

1. Add per-scenario config override support so scenarios can test production-like protection settings
2. Add scenario 07: protection-filtered — tests compress with `preserveRecentMessages: 5`, verifies protected messages excluded from compressed set
3. Add scenario 08: nudge-with-protection — tests nudge→compress flow WITH protection enabled (the exact bug scenario from PR #210/#212)
4. Deepen verify.ts with `compressedCount` / `minCompressedCount` / `maxCompressedCount` checks
5. Add all scenarios (05-08) to CI `ci.yml`
6. Update README with new scenario format documentation

## Acceptance Criteria

- All 8 E2E scenarios pass locally
- Build + typecheck + 922 unit tests still pass
- CI runs all 8 scenarios
