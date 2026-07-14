# REQ - CI Setup

- Task ID: `2026-05-17_ci-setup`
- Home Repo: `opencode-acp`
- Created: 2026-05-17
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: PR #2 (merged to master)

## 1. Background & Problem Statement

- **Context**: Project had no CI/CD. Tests ran only locally. PRs merged without automated verification.
- **Current behavior (symptom)**: No automated checks on push/PR. Broken builds could reach master.
- **Expected behavior**: GitHub Actions CI runs typecheck, tests, and build on every push and PR. Node.js 22/24 matrix.
- **Impact**: Without CI, regressions are caught only after merge. Collaborators cannot verify their changes without local setup.

## 2. Reproduction (if applicable)

- N/A — infrastructure change.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Use GitHub Actions (standard for public GitHub repos)
    - Test on Node 22 and 24 (matrix strategy)
    - Steps: typecheck → test → build (in order)
- **Non-Goals**:
    - Automatic npm publish on tag
    - Code coverage reporting
    - Preview deployments

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] CI workflow triggers on push to master and on pull requests
    - [x] CI runs typecheck, test, and build steps
    - [x] Node 22 and 24 matrix works
- **Performance / Stability**:
    - [x] CI completes in under 5 minutes
- **Regression**:
    - [x] Existing 343 tests pass in CI environment
        - [x] PR #2 merged successfully to master

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `.github/workflows/ci.yml` — New CI workflow
- **Risks**: None — additive change
- **Rollback strategy**: Delete `.github/workflows/ci.yml`
