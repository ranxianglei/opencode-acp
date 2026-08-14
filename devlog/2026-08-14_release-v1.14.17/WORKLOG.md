# WORKLOG — v1.14.17: Eliminate compress retry dead-ends (#301)

## Investigation

- Issue #301 trace: `compress [acknowledgeRisk=true]` → `content[0] needs a topic` → retry with `topic` → `Parameter "acknowledgeRisk": true was provided, but no quality gate rejection is pending`.
- `qualityGateRetryPending` (lib/state/types.ts) is only set by a quality-gate
  rejection in `lib/compress/range.ts`. Argument-validation errors thrown in
  `validateArgs` (lib/compress/range-utils.ts) never arm it.
- The quality-gate rejection template (lib/compress/quality-gate/rejection.ts)
  teaches `add "acknowledgeRisk": true to retry`; models generalize this to
  every retry, so any validation error followed by a compliant retry hit the
  preemptive guard — a dead-end loop.
- `validateArgs` also required every content entry to carry a topic (own or
  top-level fallback), a second hard failure of the same class.

## Change

Cherry-picked from PR #303 (ca19139) and PR #302 (053987c) onto master:

1. **Preemptive acknowledgeRisk → no-op** (`lib/compress/range.ts`):
   `bypassQuality = acknowledgeRisk && qualityGateRetryPending`;
   when no rejection is pending the flag is ignored with a warn log and an
   `⚠️ acknowledgeRisk was ignored` note in the result. Quality checks always
   run unless a real rejection armed the bypass. Removed
   `buildPreemptiveAcknowledgeError` (quality-gate/rejection.ts, index.ts).
2. **Optional topics** (`lib/compress/range-utils.ts`): dropped the topic
   throw; added `deriveFallbackTopic(summary)` (first non-empty line, markdown
   heading stripped, capped at 80 chars) filled by `resolveRanges` when both
   entry.topic and top-level topic are absent. Prompt files + types updated.

## Verification

- typecheck (`tsc --noEmit`): clean.
- tests: 976 pass / 0 fail (includes 3 reworked batch-compress cases + new
  deriveFallbackTopic unit test + reworked no-op integration tests).
- Quality-gate protection verified unchanged: bad summary + preemptive
  acknowledgeRisk is still rejected by the QUALITY gate (not a parameter
  error) and arms the flag for retry.

## Release

- Version bump 1.14.16 → 1.14.17 (package.json).
- Changelog entries in README.md + README.zh-CN.md.
- Branch `2026-08-14_release-v1.14.17`, commit `release: v1.14.17 — ...`.
- Supersedes PR #302 + PR #303 (this release branch contains both commits).
