# REQ - Update QQ community group in README (EN + ZH)

- Task ID: `2026-09-22_new-qq-group`
- Home Repo: `opencode-acp`
- Created: 2026-09-22
- Status: Done
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/billion-context/issues/1113

## 1. Background & Problem Statement

- **Context**: The three sibling projects (`billion-context`, `billion-context-pi`, `opencode-acp`) share a single QQ community group. The original group (`1056132097`) has reached its member cap and can no longer accept new members; the new group (`1108730198`) is now the active one.
- **Current behavior (symptom)**: Both `README.md` and `README.zh-CN.md` still list only the old, now-full group `1056132097`, so new users cannot join.
- **Expected behavior**: Both language READMEs list the new group `1108730198` as the group to join, while noting the original `1056132097` is full.
- **Impact**: Discoverability of the community channel only; no runtime/functional impact.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Docs-only; must not change `version` or any code/config.
- **Non-Goals** (explicitly out of scope):
  - No version bump, no CHANGELOG entry (no version change), no code changes.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `README.md` `## Community` section lists **QQ Group: 1108730198** as the group to join, noting the original `1056132097` is full.
  - [x] `README.zh-CN.md` `## 社区` section lists **QQ 群:1108730198** as the group to join, noting the original `1056132097` is full.
- **Regression**: N/A — documentation only; no test-suite changes.
