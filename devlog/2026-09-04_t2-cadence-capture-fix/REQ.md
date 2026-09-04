# REQ - T2 distillation starved by per-compress cadence reset (issue #364 P1)

## Context

Source: issue #364 (ranxianglei/opencode-acp). A 21-day hub session (glm-5.3, limit=1M,
v1.14.x) fired Tier-2 distillation only 3 times; tier-1 quality crossed the 50K trigger
threshold 4 times, twice with 12~22h delays while remaining above threshold (23 and 25
T1 captures in between).

## Root cause (verified on current master)

`lib/messages/inject/inject.ts` compress-processing handler (`:117-179`): every NEW
compress message — regardless of tier — reset the tier cadence baselines:

```ts
state.nudges.lastTier2NudgeTokens = currentTokens
state.nudges.lastTier3NudgeTokens = currentTokens
```

The reset was introduced by #235 to stop T2/T3 re-trigger loops (undefined baseline =
"never fired" → immediate re-fire). But it also fires for raw-message T1 captures,
which INCREASE tier-1 quality instead of consuming it. In compression-active sessions
every T1 capture re-arms the growthFloor wait (22.5K on defaults), so T2 can only fire
in the gap between two T1 captures — systematic distillation starvation.

## Scope decision

- THIS PR — fix #2 of the issue (tier-aware cadence reset). Confirmed live bug, auto-fixes
  the 12~22h delays, no product decisions required.
- DEFERRED — fix #1 (decouple T2/T3 trigger threshold from `nudgeGrowthTokens`, new config
  field + default value). Needs the owner's ruling on the default (absolute ~20K vs
  anchor-count >= 12 vs dual whichever-first); ~8-file config surface. Fast follow-up.
- DEFERRED — fix #3 (tier checks also run on T1-nudge turns): after this fix T1 nudges
  are spaced by growthFloor, so the residual T2 delay is one turn, not hours.
- DEFERRED — fix #4 (pointer-ize consumed anchors): separate issue.

## Design

Classify the just-processed compress call by its range-boundary prefix — the convention
already documented in `lib/compress/state.ts:81-83` ("m-prefix = T1 capture; b-prefix =
T2+ distilling summaries"):

- `mNNNNN` boundaries only → raw-message capture → do NOT touch tier baselines.
- any `bN` boundary → real distillation/condensation → reset baselines (preserve #235).
- unparsable/missing boundaries → conservative: reset (loop-prevention wins).

## Acceptance criteria

- [x] T1 capture compress leaves `lastTier2NudgeTokens`/`lastTier3NudgeTokens` unchanged.
- [x] Block-ref distill compress still resets them (and never to `undefined`) — #235 lock.
- [x] Existing #235 regression test (inject.test.ts phase 1-3) still green.
- [x] §5.7: multi-turn, side-effect assertions on baselines, production config
      (`preserveRecentMessages > 0`), growth-cycle test.
- [x] New tests FAIL when the fix is reverted (verified by temporarily disabling the guard).
- [x] typecheck + build + full suite green.
