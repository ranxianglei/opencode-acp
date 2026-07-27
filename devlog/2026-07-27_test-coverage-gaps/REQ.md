# Test Coverage Gaps — Nudge & Growth Testing Requirements

## Problem

The baseline-reset bug (PR #207) was a 1-line production bug that survived 900+ tests. Five structural gaps allowed it:

1. **Unit tests only checked `shouldInjectThisTurn`**, not `lastPerMessageNudgeTokens` — baseline reset was invisible
2. **All tests were single-turn** — the feedback loop (baseline eaten each turn) was invisible
3. **All tests used `preserveRecentMessages: 0`** — the `nothingToCompress` path was never exercised
4. **Docker E2E only verified `blockCount`** — nudge state corruption was invisible
5. **Docker E2E scenarios only used explicit compress calls** — nudge→compress flow untested

## Fix

### 1. AGENTS.md §5.7 — New testing requirements

Added mandatory requirements for nudge/growth changes:
- §5.7.1 Unit: multi-turn, side-effect assertions, production config (`preserveRecentMessages > 0`), growth cycle
- §5.7.2 Docker E2E: nudge state verification, growth accumulation (nudge-triggered compression noted as future work — fake-llm-server limitation)
- §5.7.3 Rationale: documents why these requirements exist (postmortem of PR #207)

### 2. Docker E2E verify.ts — Nudge state verification

Added `nudgeBaselineSet` verify field: checks if `lastPerMessageNudgeTokens` is set in the state file.

## Files

- `AGENTS.md` — §5.7 (new section)
- `scripts/e2e/verify.ts` — nudge state verification
- `scripts/e2e/README.md` — added scenario 05 to table, documented `nudgeBaselineSet`
