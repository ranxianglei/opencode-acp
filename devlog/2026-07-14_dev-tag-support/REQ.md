# REQ - npm dev tag support for pre-release publishing

- Task ID: `2026-07-14_dev-tag-support`
- Home Repo: `opencode-acp`
- Created: 2026-07-14
- Status: Done
- Priority: P1
- Owner: sisyphus
- References: dog/opencode-acp#27

## 1. Background & Problem Statement

- **Context**: The project needs a way to publish pre-release versions for testing without affecting the stable `latest` tag on npm. Users want to test features (PR #132, #134) before they become the default.
- **Current behavior**: `release.yml` always publishes with the default npm tag (`latest`). There is no way to publish a `dev` or pre-release version.
- **Expected behavior**: When `package.json` version contains a prerelease segment (e.g., `1.13.0-dev.1`), CI should publish with `--tag dev` and mark the GitHub Release as a prerelease.
- **Impact**: Enables iterative testing of features before stable release.

## 2. Reproduction (if applicable)

N/A — feature addition, not bug fix.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: stable releases (`1.13.0`) must continue using `latest` tag.
  - No changes to PR workflow — feature branches still target `master`.
  - No long-lived `dev` branch — dev releases use the same release branch pattern with prerelease version numbers.
- **Non-Goals**:
  - No `dev` branch management.
  - No per-commit dev builds (only release branch merges publish).
  - No custom tag names beyond `dev` for prereleases (future enhancement).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Version `1.13.0` → `npm publish` (default `latest` tag)
  - [x] Version `1.13.0-dev.1` → `npm publish --tag dev`
  - [x] Version `1.13.0-beta.2` → `npm publish --tag dev` (all prereleases)
  - [x] GitHub Release marked as prerelease for prerelease versions
  - [x] Detection logic uses version string from `package.json`, not branch name

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `.github/workflows/release.yml` — add prerelease detection in "Read version" step, conditional `--tag` in "Publish to npm" step, `prerelease` flag in "Create GitHub Release" step
- **Risks**: Low — only CI workflow file changed. No source code, no tests, no config.
- **Rollback strategy**: Revert single commit.
