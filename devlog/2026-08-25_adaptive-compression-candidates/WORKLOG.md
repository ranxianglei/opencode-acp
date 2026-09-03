# WORKLOG - Adaptive Compression Candidates

- Task ID: `2026-08-25_adaptive-compression-candidates`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-25

## 1. Summary

- **What was done**: Added executor-parity planning, pure micro/episode candidate
  planning, shared nudge/status rendering, graduated action-oriented nudges, and
  focused/property/E2E coverage. Refined the nudge wording to preserve active
  work explicitly while asking for cleanup when clearly stale candidates exist.
- **Why**: The feature must improve recommendation precision without changing
  ACP's mature compression lifecycle.
- **Behavior / compatibility changes**: Advisory candidate guidance is now shown
  in nudges and default status; first soft nudges ask for one clearly stale
  candidate, repeated nudges escalate to an explicit single-candidate action,
  and emergency nudges remain direct without requiring all candidates. Existing
  range execution remains available.
- **Risk level**: Medium

## 2. Change Log

### Commits

| Commit  | Description                               |
| ------- | ----------------------------------------- |
| This PR | Implementation and verification completed |

### Key Files

- `devlog/2026-08-25_adaptive-compression-candidates/` — requirements,
  architecture design, and implementation worklog.
- `lib/compress/range-utils.ts` — shared executor-equivalent plan preparation.
- `lib/messages/inject/candidates.ts` — pure atomic-unit candidate planner and
  bounded renderer; episodes split at protected units so eligible history is
  not discarded with a protected tail.
- `lib/messages/inject/inject.ts`, `lib/hooks.ts`, `lib/compress/status.ts` —
  nudge/status integration, candidate snapshot flow, and planner-authoritative
  production nudge gating; post-compression candidate-planning fast path.
- `lib/messages/sync.ts`, `lib/hooks.ts` — avoids rebuilding unchanged message
  memberships after a persisted-state repair sync; candidate planning is gated
  before full planner work.
- `lib/prompts/system.ts`, `lib/prompts/*-nudge.ts`,
  `lib/prompts/compress-range.ts` — bundled candidate semantics and advisory
  safety/action guidance.
- `tests/nudge-text.test.ts`, `tests/prompts.test.ts` — graduated prompt
  assertions and active-work safety wording.
- `tests/compression-candidates*.test.ts` — unit, parity, integration, and
  property coverage.
- `scripts/e2e/scenarios/13-adaptive-compression-candidates.json` — real nudge
  candidate-selection scenario.

## 3. Design & Implementation Notes

- **Entry point / key function**: `injectCompressNudges`, `buildStatusReport`,
  `prepareExecutableRangePlans`, and `planCompressionCandidates`.
- **Key configuration items**: Existing `compress.minCompressRange`, recent
  protection, protected tools, and protected file patterns.
- **Key logic explanation**: Candidates are built from pair-safe atomic units;
  large units become micro-ranges, residual contiguous units become episodes,
  and every output is validated against shared executor selection semantics.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm test
npm run format:check
npm run build
./scripts/dev-deploy.sh --check
```

### Test Coverage

- New/modified test files: `compression-candidates.test.ts`,
  `compression-candidates-property.test.ts`, `acp-status.test.ts`,
  `e2e-blocks-nudges.test.ts`, `sync.test.ts`, and `state-utils-pure.test.ts`.
- Test count: Full upstream-integrated suite 1098 tests, 1098 passed.
- Key scenarios verified: pair-safe micro-ranges, episode aggregation,
  protection parity, deterministic cap, nudge/status parity, and E2E candidate
  selection.

### Results

- **PASS/FAIL**: PASS for typecheck, build, full unit suite, focused formatting,
  and scenario 13 E2E.
- **Graduated nudge checks**: PASS for first-nudge action wording, repeated
  nudge escalation, baseline preservation, and post-compression reset.
- **Review follow-ups**: PASS for protected-tail episode splitting and valid
  planner candidates surviving legacy grouped-range filtering.
- **Performance follow-up**: no-nudge turns skip candidate planning; unchanged
  active block membership retains existing per-message arrays after a repair
  sync; tool-cache ordering is retained because it records step-start turns.
  Candidate planning occurs before truncation, while synthetic nudge suffixes
  are excluded from truncation's real-message protection window.
- **Key logs/data**: `npm run format:check` reports pre-existing formatting
  failures in unrelated files; all changed-file formatting checks pass.

## 5. Risk Assessment & Rollback

- **Risk points**: Pair closure, protection parity, nudge state preservation,
  prompt-size growth, and status projection parity.
- **Rollback method**:
    - Revert implementation commit(s) after review.
    - Rollback impact: recommendations return to the existing grouped ranges;
      compression state and existing blocks remain readable.
- **Compatibility notes** (data format, config schema): No changes planned.

## 6. Lessons Learned (optional)

- The existing executor admits a batch using deduplicated post-filter message
  characters, not approximate recommendation tokens; parity must be explicit.

## 7. Follow-ups (optional)

- [ ] Observe real-session selection before considering artifact capsules.
