# REQ - CI Enforcement for Development Standards

- Task ID: `2026-07-11_ci-enforcement`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: InProgress
- Priority: P0
- Owner: awork
- References: issue #25

## 1. Background & Problem Statement

- **Context**: AGENTS.md defines development standards (devlog, branch naming, changelog) but relies on manual compliance. Multiple violations occurred during v1.11.1 release: version bump committed directly to master, missing devlog, missing changelog.
- **Current behavior**: Only `ci.yml` runs typecheck + test + build. No validation of devlog, branch naming, or changelog.
- **Expected behavior**: CI enforces AGENTS.md standards automatically. PRs without devlog fail. Release PRs without changelog fail. Tag pushes trigger auto-publish.
- **Impact**: Eliminates manual enforcement, prevents compliance issues from reaching master.

## 2. Constraints & Non-Goals

- **Constraints**:
  - Must work with existing GitHub branch protection on master
  - Must not break existing CI workflow
  - Auto-publish needs `NPM_TOKEN` secret in GitHub repo settings
- **Non-Goals**:
  - No changes to AGENTS.md itself
  - No changes to source code

## 3. Acceptance Criteria

- **Correctness**:
  - [ ] PR check script validates branch name, devlog, changelog
  - [ ] PR check workflow runs on all PRs to master
  - [ ] Release workflow triggers on `v*` tag push
  - [ ] Release workflow builds, tests, and publishes to npm
  - [ ] Release workflow creates GitHub Release
- **Regression**:
  - [ ] Existing CI workflow unchanged
