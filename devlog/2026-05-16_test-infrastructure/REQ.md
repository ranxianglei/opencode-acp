# REQ - Test Infrastructure

- Task ID: `2026-05-16_test-infrastructure`
- Home Repo: `opencode-acp`
- Created: 2026-05-16
- Status: Done
- Priority: P0
- Owner: ranxianglei
- References: Baseline tag `v1.0.1-test-baseline` (95 tests)

## 1. Background & Problem Statement

- **Context**: ACP had only the original DCP test suite (95 tests) with no coverage for most modules. Several bugs were found during the rebrand that tests would have caught.
- **Current behavior (symptom)**: 95 baseline tests covering only hooks permissions, compress tools, message priority, token counting, context limits, and update checks. No tests for state management, compression pipeline internals, message processing, or E2E flows.
- **Expected behavior**: Comprehensive test suite covering all major modules with multiple tiers (pure, mock, functional, E2E).
- **Impact**: Without tests, regressions are caught only by manual testing or in production. The `config.ts` file (~1125 lines) had untestable runtime dependencies that needed extraction.

## 2. Reproduction (if applicable)

- N/A — this is a new capability, not a bug fix.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Test runner: Node.js built-in (`node --import tsx --test`) — no Jest, no Vitest
    - Flat `tests/` directory structure — no subdirectories
    - Tests must import from actual source files, not reimplement logic locally
- **Non-Goals**:
    - 100% line coverage — focus on behavioral coverage
    - Testing private/internal functions that aren't exported
    - Performance benchmarks

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] 4 test tiers implemented: Tier 1 (pure), Tier 2 (mock), Functional, E2E
    - [x] At least 300 tests total (target: 343)
    - [x] All tests pass with 0 failures
    - [x] Tests import from source, not local reimplementations
- **Performance / Stability**:
    - [x] Full test suite runs in under 30 seconds
- **Regression**:
    - [x] Bug found and fixed: `resetOnCompaction` didn't clear `messageIds`
    - [x] `config-validation.ts` extracted from `config.ts` for testability

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/config-validation.ts` — Extracted from `config.ts` (new file)
    - `tests/` — 15 new test files
    - `AGENTS.md` — Created with architecture documentation and test status
    - `TESTING.md` — Created with test writing guide
- **Risks**: Extracting `config-validation.ts` could break imports if not done carefully
- **Rollback strategy**: Remove new test files; revert `config-validation.ts` extraction
