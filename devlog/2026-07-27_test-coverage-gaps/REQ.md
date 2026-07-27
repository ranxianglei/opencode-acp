# Test Coverage Gaps — Nudge & Growth Testing Requirements

## Problem

The baseline-reset bug (PR #207) was a 1-line production bug that survived 900+ tests. Three structural gaps allowed it:

1. **Unit tests only checked `shouldInjectThisTurn`**, not `lastPerMessageNudgeTokens` — baseline reset was invisible
2. **All tests were single-turn** — the feedback loop (baseline eaten each turn) was invisible
3. **All tests used `preserveRecentMessages: 0`** — the `nothingToCompress` path was never exercised
4. **Docker E2E only verified `blockCount`** — nudge state corruption was invisible
5. **Docker E2E scenarios only used explicit compress calls** — nudge→compress flow untested

## Fix

### 1. AGENTS.md §5.7 — New testing requirements

Added mandatory requirements for nudge/growth changes:
- §5.7.1 Unit: multi-turn, side-effect assertions, production config (`preserveRecentMessages > 0`), growth cycle
- §5.7.2 Docker E2E: nudge-triggered compression, nudge state verification, growth accumulation
- §5.7.3 Rationale: documents why these requirements exist (postmortem of PR #207)

### 2. Docker E2E verify.ts — Nudge state verification

Added 2 new verify fields:
- `nudgeBaselineSet`: boolean — checks if `lastPerMessageNudgeTokens` is set
- `nudgeBaselineNotEquals`: number — catches baseline reset bugs

### 3. Docker E2E scenario — Nudge growth compress

New scenario `06-nudge-growth-compress.json`: 5 text turns → compress all → verify block count + nudge baseline set.

### 4. E2E README — Updated documentation

Documented new scenario and verify fields.

## Files

- `AGENTS.md` — §5.7 (new section)
- `scripts/e2e/verify.ts` — nudge state verification
- `scripts/e2e/scenarios/06-nudge-growth-compress.json` — new scenario
- `scripts/e2e/README.md` — updated docs
