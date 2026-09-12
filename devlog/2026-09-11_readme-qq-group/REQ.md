# REQ - Add QQ community group to README (EN + ZH)

- Task ID: `2026-09-11_readme-qq-group`
- Home Repo: `opencode-acp`
- Created: 2026-09-11
- Status: Done
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/billion-context/issues/698

## 1. Background & Problem Statement

- **Context**: The three sibling projects (`billion-context`, `billion-context-pi`, `opencode-acp`) share a single QQ community group (`1056132097`) for discussion, support, and updates. This is not surfaced in any README.
- **Current behavior (symptom)**: Neither `README.md` nor `README.zh-CN.md` has a community/QQ section.
- **Expected behavior**: A Community section in both language READMEs lists the shared QQ group and notes it covers all three projects.
- **Impact**: Discoverability of the community channel only; no runtime/functional impact.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Docs-only; must not change `version` or any code/config.
- **Non-Goals** (explicitly out of scope):
  - No version bump, no CHANGELOG entry (no version change), no code changes.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `README.md` has a `## Community` section listing **QQ Group: 1056132097**, placed near the top (before the first content section).
  - [x] `README.zh-CN.md` has a `## 社区` section listing **QQ 群:1056132097**, placed near the top (before the first content section).
- **Regression**: N/A — documentation only; no test-suite changes.
