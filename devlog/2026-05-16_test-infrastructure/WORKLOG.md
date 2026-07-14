# WORKLOG - Test Infrastructure

- Task ID: `2026-05-16_test-infrastructure`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-05-19

## 1. Summary

- **What was done**: Built complete test suite from scratch — 95 → 343 tests across 4 tiers (Tier 1 pure, Tier 2 mock, Functional, E2E). Extracted `config-validation.ts` from `config.ts` for testability. Created `AGENTS.md` and `TESTING.md`.
- **Why**: Original DCP test suite had minimal coverage. Bugs during rebrand showed the need for comprehensive testing.
- **Behavior / compatibility changes**: Yes — `config-validation.ts` extracted as a new module. `resetOnCompaction()` now clears `messageIds`.
- **Risk level**: Low — new test files and one extracted module; no behavior changes to production code

## 2. Change Log

### Commits

| Commit    | Description                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `d5f1540` | test: fix 10 failing tests for ACP rebrand and config changes                       |
| `d2bc632` | docs: add AGENTS.md with architecture, dev standards, and test status               |
| `04105e2` | test: add TESTING.md + 83 Tier 1 unit tests (178 total, 0 failures)                 |
| `7471a1b` | test: add 68 Tier 2 mock-data unit tests (246 total, 0 failures)                    |
| `90b8c00` | test: add 77 functional tests for compress pipeline (322 total, 0 failures)         |
| `7268202` | test: add 21 E2E tests for full message-transform pipeline (343 total, 0 failures)  |
| `17aa4c1` | fix: resolve 4 critical test review issues + add mandatory test review to AGENTS.md |
| `b4529f9` | fix: restore purgeErrors.turns positive-number validation lost during extraction    |

### Key Files

- `lib/config-validation.ts` — New: pure validation logic extracted from `config.ts`
- `tests/config-validation.test.ts` — 83 pure tests for config validation
- `tests/priority-classify.test.ts`, `tests/shape.test.ts`, `tests/query-pure.test.ts`, `tests/gc-truncate-pure.test.ts`, `tests/state-utils-pure.test.ts` — Tier 1 pure tests
- `tests/query-mock.test.ts`, `tests/gc-truncate-mock.test.ts`, `tests/strategies-dedup.test.ts`, `tests/strategies-purge-errors.test.ts` — Tier 2 mock tests
- `tests/compress-search.test.ts`, `tests/compress-state.test.ts`, `tests/message-ids.test.ts` — Functional tests
- `tests/e2e-message-transform.test.ts`, `tests/e2e-blocks-nudges.test.ts` — E2E tests
- `AGENTS.md` — New: comprehensive development specification
- `TESTING.md` — New: test writing guide

## 3. Design & Implementation Notes

- **Entry point / key function**: Tier 1 tests pure functions (no side effects). Tier 2 uses mock data. Functional tests exercise compress pipeline with factories. E2E tests run full message-transform pipeline.
- **Key configuration items**: `buildConfig()` factory used across tests to create valid `PluginConfig` objects
- **Key logic explanation**: `config-validation.ts` was extracted because `config.ts` has runtime dependencies (file I/O, SDK types) that made it untestable. The extraction separated pure validation logic into an importable module.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build        # Passes
npm run typecheck    # Passes
npm run test         # 343 tests, 0 failures
```

### Test Coverage

- New test files: 15
- Test count: 343 total, 343 pass, 0 fail
- Key scenarios verified: config validation, message priority, shape analysis, boundary search, block allocation, message ID mapping, full compress pipeline, nudge injection

### Results

- **PASS**: All 343 tests pass
- **Bug found during testing**: `resetOnCompaction()` didn't clear `messageIds` — fixed in `25cc269` (part of rebrand iteration)
- **Review findings**: 4 critical/important issues found by 3 independent reviewers and fixed in `17aa4c1` and `b4529f9`

## 5. Risk Assessment & Rollback

- **Risk points**: `config-validation.ts` extraction could introduce import path issues
- **Rollback method**: Revert commits `d5f1540` through `b4529f9`
- **Compatibility notes**: `purgeErrors.turns` validation was accidentally lost during extraction; restored in `b4529f9`

## 6. Lessons Learned

- What went well: 4-tier structure (pure → mock → functional → E2E) provides clear separation of concerns
- What could be improved: Should have extracted `config-validation.ts` before writing tests (would have avoided the lost validation bug)
- Reusable conclusions: `buildConfig()` factory pattern prevents missing required config fields in tests. Independent review caught issues that self-review missed.
