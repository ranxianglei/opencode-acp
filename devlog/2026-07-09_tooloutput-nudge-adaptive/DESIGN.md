# DESIGN - toolOutput reminder must scale with context (5% protection bypass)

- Task ID: `2026-07-09_tooloutput-nudge-adaptive`
- Home Repo: `opencode-acp`
- Created: 2026-07-09
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** The toolOutput accumulation reminder uses a
  hardcoded 5000-token threshold, while the growth nudge uses an adaptive 5% of
  context (50K on a 1M model). On large-context models the reminder fires ~10×
  too often and independently of the growth gate, bypassing the 5% protection
  and causing over-compression.
- **Why now?** Reported via Gitea issue #18 with a clear reproducer session
  (ses_0c2244c0bffeChX2cflIq4jrVz): 68 compressions / 499 LLM calls, never above
  22.6% context. The bug also reproduces live in any long tool-heavy session on
  a large-context model.

## 2. Goals & Non-Goals

- **Goals**:
  - Align the toolOutput reminder threshold with the adaptive growth threshold.
  - Make the `toolOutputNudgeThreshold` config override actually work.
- **Non-Goals**:
  - Persisting `modelContextLimit` (separate issue).
  - Re-architecting the dual-nudge system.

## 3. Current Architecture

```
injectCompressNudges (inject.ts)
  ├─ computeShouldNudge()        # growth nudge gate
  │     uses nudgeGrowthTokens   # ADAPTIVE: 5% of ctx, [6K,50K]
  │
  ├─ toolOutput reminder         # INDEPENDENT gate
  │     uses toolOutputThreshold # FIXED: 5000  ← BUG
  │     fires even when shouldNudge == false
  │
  └─ suffix injection            # reminder text added regardless of shouldNudge
```

- **Pain points**: Two gates with different scales; the more sensitive one wins.

## 4. Proposed Architecture

```
injectCompressNudges (inject.ts)
  ├─ computeShouldNudge()        # growth nudge gate (unchanged)
  │     uses nudgeGrowthTokens   # ADAPTIVE: 5% of ctx, [6K,50K]
  │
  ├─ toolOutput reminder         # INDEPENDENT gate (threshold now adaptive)
  │     uses toolOutputThreshold # ADAPTIVE: override ?? nudgeGrowthTokens
  │
  └─ suffix injection            # unchanged
```

- **Key change**: `toolOutputThreshold` defaults to `nudgeGrowthTokens` instead
  of 5000. The override (`compress.toolOutputNudgeThreshold`) now flows through
  config merge, so a user can still tighten/loosen it.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Threshold default | (a) keep 5000, (b) `?? nudgeGrowthTokens`, (c) fraction of nudgeGrowthTokens | (b) | Reuses the already-computed adaptive value; minimal change; same 5% semantics as the growth nudge. (c) adds an unneeded second ratio. |
| Reminder independence | (a) gate behind `shouldNudge`, (b) keep independent | (b) keep independent | The reminder serves a distinct signal (tool-output accumulation). Keeping it independent but context-scaled preserves its purpose without subverting the 5% protection. |
| Override wiring | (a) leave dead, (b) wire through merge/validation/schema | (b) | A declared config field that silently does nothing is a footgun; wiring it is purely additive. |

## 6. Impact Analysis

- **Backward compatibility**: Additive. No persisted-state change. Internal
  `dcp` naming preserved.
- **Performance**: Negligible (one `??` evaluation; config field already typed).
- **Security**: N/A.
- **Dependencies**: None.

## 7. Migration Plan

- **Steps**: None — the change is purely behavioral (reminder fires less often)
  and additive (override becomes live).
- **Feature flags / gradual rollout**: Not needed.

## 8. Open Questions

- [ ] (Follow-up) Persist `modelContextLimit` so the adaptive floor doesn't bite
      on restart — tracked in WORKLOG §7.
