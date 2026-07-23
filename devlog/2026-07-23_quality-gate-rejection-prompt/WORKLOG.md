# WORKLOG - Quality-gate rejection recovery guidance

- Task ID: `2026-07-23_quality-gate-rejection-prompt`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-23 00:55

## 1. Summary

- **What was done**: Made the quality-gate rejection recovery path discoverable
  by the model — added a `.describe()` to `acknowledgeRisk`, branched the
  rejection message to advise SPLITTING oversized ranges (vs the old "rewrite
  longer" hint that is impossible for 243K-token ranges), and added a
  "COMPRESSION REJECTION HANDLING" section to the system prompt.
- **Why**: In dog/opencode-acp#33, glm-5.2 deadlocked — it tried to compress a
  243K-token range into an 8543-char summary, the blocking pre-commit gate
  rejected it 23×, and the model never discovered the correct recovery (split
  / summaryMaxChars / acknowledgeRisk). Each failure re-billed ~320K tokens.
- **Behavior / compatibility changes**: No. The gate's pass/fail logic, state
  schema, persisted format, and exported signatures are unchanged. Only guidance
  text (tool schema description, error message body, system prompt) changed.
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (this PR) | fix: guide models to the correct quality-gate rejection recovery path |

### Files

| File | Change |
|------|--------|
| `lib/compress/range.ts` | `acknowledgeRisk` gains a `.describe()` (was the only param without one) |
| `lib/compress/message.ts` | same `acknowledgeRisk` `.describe()` for message mode |
| `lib/compress/quality-gate/rejection.ts` | `buildQualityRejectionError` now branches: ranges >50K tokens get SPLIT guidance, smaller ranges get denser-summary guidance; both mention `summaryMaxChars` + `acknowledgeRisk` |
| `lib/prompts/system.ts` | new "COMPRESSION REJECTION HANDLING" section (3 recovery paths in priority order + anti-loop rule) |
| `tests/quality-gate-enforcement.test.ts` | +2 tests: large-range → split guidance; small range → denser-summary guidance |

## 3. Verification

- `npm run typecheck` — clean.
- `npm test` — 837 pass, 0 fail (includes the 2 new tests).
- `npm run build` — success; `dist/index.js` contains "SPLIT THE RANGE",
  "COMPRESSION REJECTION HANDLING", and the new `acknowledgeRisk` describe.
- Existing rejection tests (`buildQualityRejectionError includes range, stats,
  and acknowledgeRisk instructions`; ratio/retention computation) still pass.

## 4. Pre-existing issues noticed (NOT addressed here)

- `npm run format:check` flags 246 files on clean `github/master` — prettier
  config drift, predates this PR, not enforced by CI (`ci.yml` runs only
  typecheck + test). Reported separately; this PR keeps its diff to intended
  changes only.
- README/AGENTS.md document the quality gate as "non-blocking (logger.warn
  only)" but `qualityGate.enabled` also activates a blocking pre-commit gate.
  Doc mismatch — follow-up.

## 5. Follow-ups

- README doc fix for the blocking-vs-non-blocking gate description.

## 6. Round 2 — make `acknowledgeRisk` usable anytime (per issue #33 feedback)

- **Trigger**: user analyzed the pre-restart session (dog/opencode-acp#33) and
  found the model doing a "write-short → rejected → retry-with-ACK" dance 7× in
  a row. User's reframe: the "ACK only after a rejection" rule MANUFACTURES the
  deliberate-fail pattern, and over-blocking causes the model to avoid
  compressing entirely (the actual root of the 330K problem) — worse than
  occasional bad compressions.
- **Change**: removed the preemptive-`acknowledgeRisk` guard so ACK bypasses
  the gate on the FIRST attempt, no prior rejection needed. The gate still
  BLOCKS non-ACK calls (protection by default + explicit opt-out → the model is
  never trapped into avoiding compression). Post-commit `evaluateBatchQuality`
  still runs + warns → observability retained.
- **Removed**: `buildPreemptiveAcknowledgeError` (now dead code), its export,
  and its test. The integration test "preemptive acknowledgeRisk ... is
  rejected" was FLIPPED to assert it now succeeds.
- **Wording**: `acknowledgeRisk` `.describe()` and the system-prompt ACK bullet
  no longer say "never preemptive"; they say "usable on the first attempt".
- **Verification**: `npm run typecheck` clean; `npm test` 836 pass / 0 fail;
  `npm run build` ok; bundle verified (guard text gone, new describe present).
- **Dropped earlier idea**: "constrain ACK / refuse short-summary ACK /
  rate-limit" — would worsen over-blocking; explicitly rejected by user.
- **Still out of scope**: making the gate fully advisory (warn-only). This PR
  keeps it blocking for non-ACK calls; free-ACK is the middle ground.

## Iteration 3 — hardcoded-values cleanup (review follow-up)

- **Trigger**: review (dog/opencode-acp#34) flagged three hardcoded values that
  drifted from config reality.
- **Fix 1 — `ratioNum` dead code** (`rejection.ts`): the PR added a
  `ratioNum: number | null` field to `computeStats`'s return, but no caller
  read it (`buildRecoveryGuidance` uses `originalTokens`; metrics use the
  pre-formatted `ratio` string). Leftover from a dropped ratio-branching idea.
  Removed the field + its computation; inlined `ratio` again.
- **Fix 2 — `12000` stale example** (`rejection.ts`, `system.ts`): the
  escapeHatches string and system-prompt both hardcoded `12000` as a
  `summaryMaxChars` example, but the real `maxSummaryLengthHard` default is
  `20000` (`config.ts`), and the tool schema already interpolates the real
  value. The example was both wrong and frozen (didn't follow config).
  - `rejection.ts`: `buildQualityRejectionError` now takes
    `maxSummaryLengthHard: number` as a 3rd param; `buildRecoveryGuidance`
    receives it and interpolates `${maxSummaryLengthHard}`.
    Callers `range.ts`/`message.ts` pass `ctx.config.compress.maxSummaryLengthHard`.
  - `system.ts`: removed the number entirely (static prompt string can't
    interpolate config; now says "see the tool schema for the current max").
  - `tests/quality-gate-enforcement.test.ts`: all 4 call sites updated to pass
    `20000`.
- **Fix 3 — `layer1MinRetentionPct` 5.0 vs 1.0** (`config.ts`): the runtime
  default was `5.0` but `dcp.schema.json`, `README.md`, and the cc-alg
  `DEFAULT_ROUGE_RECALL_V1_CONFIG` all say `1.0`. The v1.13.0 changelog
  documents the floor as 1%. The `LARGE_RANGE_TOKENS = 50_000` threshold
  rationale (crossover where the 1% floor demands a multi-thousand-char
  summary) assumes 1%; at 5% the real crossover is ~12K tokens. Aligned
  `config.ts` to `1.0`. Updated the `LARGE_RANGE_TOKENS` comment to name the
  config key and note the proportional coupling.
- **Verification**: `npm run typecheck` clean; `npm test` 836 pass / 0 fail;
  `npm run build` ok.
