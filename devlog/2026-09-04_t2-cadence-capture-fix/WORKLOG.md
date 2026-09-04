# WORKLOG - T2 distillation starved by per-compress cadence reset (issue #364 P1)

## Changes

| File | Change |
| --- | --- |
| `lib/messages/query.ts` | New `isCaptureOnlyCompress` (boundary-prefix classifier) + `extractCompressBoundaryIds` (tolerant input reader: object or JSON-string). Conservative false on unparsable input. |
| `lib/messages/inject/inject.ts` | Import `isCaptureOnlyCompress`; wrap the tier-baseline reset in `if (!isCaptureOnlyCompress(lastCompressMsg))` — captures no longer move the baselines. |
| `tests/query-pure.test.ts` | +11 unit tests for the classifier (m/b/mixed/string/malformed/whitespace/user/non-compress/undefined). |
| `tests/inject.test.ts` | +3 integration tests: capture multi-turn baseline-hold (§5.7, production preserve-recent knobs), distill reset contrast (#235 lock), full cadence cycle (capture → baseline held → growth → T2 fires). |

## Verification

- Full suite: 1091/1091 pass (`npm run test`).
- typecheck (`tsc --noEmit`) + build (`tsup`) green.
- Fail-without-fix (§5.7.3): temporarily set `captureOnly = false` →
  `issue #364 P1` and `issue #364 cycle` tests FAIL; the distill contrast test and all
  legacy tests stay green; fix then re-applied.
- Existing #235 regression test unaffected: its compress fixture uses `input: {}` →
  classifier returns conservative false → reset still happens.

## Notes / decisions

- Detection reads the last compress message's tool-part input boundaries; matches the
  documented convention in `lib/compress/state.ts:81-83`. No new state fields, no
  persisted-format change.
- Mixed `m`+`b` batch treated as distillation (conservative for loop-prevention).
- `lastTier3NudgeTokens` also moves on any real distillation (T2 or T3) — harmless:
  the T3 threshold gate (`tier2Tokens >= nudgeGrowthTokens`) independently prevents
  premature T3 firing.
- During the cycle test the pre-existing downward baseline correction
  (`inject.ts:294-302`) legitimately re-anchors `lastPerMessageNudgeTokens` to
  currentTokens — asserted explicitly to document the interaction.
- Environment hiccup during work: workspace volume hit ENOSPC mid-task; resumed after
  ~300 MB freed; one edit was silently truncated (lost a `})`) and was repaired by the
  syntax-error bisect (esbuild "Unexpected end of file" → structure map → restored).

## Follow-ups

- Fix #1 (decouple T2/T3 threshold; new `tierTriggerTokens` config field) — waiting on
  owner's default-value ruling (issue #364 discussion; interacts with #300).
- Fix #3 (tier checks on T1-nudge turns) — optional, residual delay is one turn now.
