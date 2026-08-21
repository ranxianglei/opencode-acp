# WORKLOG — Emergency + Nothing-Compressible Notice

## Changes

`lib/messages/inject/inject.ts`:
- `emergencyNoTargets = emergencyOverride && nothingToCompress`
- `shouldInjectNudge = nudgeAllowed && !nothingToCompress` (removed the emergency bypass)
- `shouldInjectNotice = emergencyNoTargets && noticeCadenceMet` — cadence reuses
  `lastNudgeShownTokens` + `growthFloor` (first turn always allowed)
- `applyAnchoredNudges` still gated by `shouldInjectNudge` — notice turns skip anchored compress text
- maxLimit strong alert now requires `!emergencyNoTargets`; notice turns emit a
  `🚨 Context is critically full (N% of limit)… /compact / new session / relax
  protections` text instead

`tests/inject.test.ts`:
- Replaced "emergency override fires even when all content is protected" (asserted
  the loop-driving behavior) with:
  - "emergency + all content protected emits /compact notice, not compress instructions"
  - "emergency notice is cadence-gated across turns" (3-turn: fire → silent below
    growthFloor → re-fire at ≥ growthFloor; asserts `shouldInjectThisTurn` AND
    `lastNudgeShownTokens` per turn, §5.7.1)
  - "emergency with sub-floor ranges emits notice — phantom-retry loop regression"
    (incident shape: ranges look compressible by raw size, effective below floor)

`tests/model-switch-limits.test.ts`:
- 2 assertions updated: tiny-message emergency scenarios now expect the notice
  marker ("critically full") instead of the compress-now alert

## Verification

- `tsc --noEmit`: clean
- Full suite: 1023 pass / 0 fail
- §5.7.3: surgical revert of the gate line (`nudgeAllowed && (!nothingToCompress || emergencyOverride)`)
  makes the cadence regression test FAIL; fix restored → green
- Built + deployed to `~/.cache/opencode/packages/opencode-acp@latest/`

## Stacked On

PR #325 (`2026-08-20_effective-compressible-accounting`) — the notice depends on
that PR's honest `nothingToCompress` (effective-token accounting + `allBelowMin`).

## Update: notice recommends /acp export first

User feedback: export is the better first recommendation — archive before destructive actions.
Notice order now: 1. /acp export (archive) 2. /compact or new session 3. relax protections.
Export alone does NOT free context; it preserves block summaries to a file.

## Update 3: headless-actionable notice text (v3)

Incident ses_7fb5c607 (billion-context-omp): headless `opencode run` model read
"1. Run /acp export 2. use /compact" as instructions it should execute, retried
compares/status 18 turns, context overflowed (233K > 262K), API 400. Slash
commands are user-only — the model can never run them in any mode.

- Notice reframed: model's only viable action is informing the user via its
  reply/message tool; user-side steps (/acp export → /compact / new session,
  or relax protections) become the content of that message.
- Added "Then stop retrying and await the user's response."
- Test asserts the reply/message-tool framing.
