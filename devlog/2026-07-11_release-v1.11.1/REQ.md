# REQ - Release v1.11.1

- Task ID: `2026-07-11_release-v1.11.1`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork
- References: PR #99, PR #102 (closed), issue #25

## 1. Background & Problem Statement

- **Context**: PR #99 fixed a compress baseline bug where `lastPerMessageNudgeTokens` and `lastToolOutputNudgeTokens` were set to pre-compression `currentTokens` instead of being cleared to `undefined`. The fix was merged to master.
- **Current behavior**: npm registry has v1.11.1 published, but GitHub master still shows v1.11.0 because the version bump commit was made directly to local master and GitHub branch protection blocked the push.
- **Expected behavior**: GitHub master should have `package.json` version `1.11.1`, matching the npm registry. README changelog should document v1.11.1 changes. Devlog should exist per AGENTS.md Section 5.1.2.
- **Impact**: Repo/registry version mismatch. Missing changelog and devlog violates AGENTS.md contributing standards.

## 2. Constraints & Non-Goals

- **Constraints**:
    - Must follow AGENTS.md Section 5.1.1 workflow (feature branch, devlog, PR)
    - Branch naming: `YYYY-MM-DD_short-title`
    - Devlog folder name must match branch name
    - README changelog must be updated in both English and Chinese
- **Non-Goals**:
    - No code changes (only version bump + documentation)
    - No npm republish (v1.11.1 already correct on registry)

## 3. Acceptance Criteria

- **Correctness**:
    - [x] `package.json` version is `1.11.1`
    - [x] `devlog/2026-07-11_release-v1.11.1/REQ.md` exists
    - [x] `devlog/2026-07-11_release-v1.11.1/WORKLOG.md` exists
    - [x] README.md has v1.11.1 changelog entry
    - [x] README.zh-CN.md has v1.11.1 changelog entry
    - [x] Branch name follows `YYYY-MM-DD_short-title` convention
- **Regression**:
    - [x] No code changes, no tests affected
