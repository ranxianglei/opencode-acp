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

- Anti-deadlock counter (auto-downgrade to non-blocking after N consecutive
  rejections of the same range) — needs a state counter → persistence migration.
  Separate PR.
- README doc fix for the blocking-vs-non-blocking gate description.
