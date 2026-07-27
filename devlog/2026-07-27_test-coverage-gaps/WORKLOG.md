# Worklog

## 2026-07-27

- Analyzed test gap: 5 structural reasons why baseline-reset bug (PR #207) survived 900+ tests
- Updated AGENTS.md §5.7: mandatory nudge/growth testing requirements (multi-turn, side-effects, production config, Docker E2E nudge verification)
- Enhanced `scripts/e2e/verify.ts`: added `nudgeBaselineSet` verify field
- Updated `scripts/e2e/README.md`: added scenario 05 to table, documented `nudgeBaselineSet`

## Round-2 (after dual-agent review)

Both Oracle + General found REQUEST_CHANGES:
- **C1**: Scenario 06 used scripted compress, not nudge-triggered — violated §5.7.2 requirement #1
- **H1**: `nudgeBaselineNotEquals` was dead code (never used in any scenario)
- **H2**: §5.7.2 "nudge-triggered compression" infeasible with current fake-llm-server
- **M1**: "three" vs "five" gaps inconsistency
- **M2**: `shouldInjectThisTurn` in requirement but not verifiable from state file
- **L1**: README missing scenario 05

Fixes applied:
- Fixed "three" → "five" in §5.7 intro
- Removed scenario 06 (violated its own requirements)
- Removed `nudgeBaselineNotEquals` (dead code)
- Reworded §5.7.2: nudge-triggered compression noted as future work (fake-llm-server limitation)
- Removed `shouldInjectThisTurn` from §5.7.2 (can't verify post-hoc from state file)
- Added scenario 05 to README table
