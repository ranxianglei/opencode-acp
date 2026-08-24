# REQ - Release v1.14.25

- Task ID: `2026-08-24_release-v1.14.25`
- Home Repo: `opencode-acp`
- Created: 2026-08-24
- Status: Done
- Priority: P1
- Owner: bili-agent (qwen3.8-27b)
- References: #335 (the feature being released)

## 1. Background & Problem Statement

- **Context**: PR #335 (self-disable under `BILLION_CONTEXT_PROXY`) is merged to master; npm `latest` is still 1.14.24, so `opencode-acp@latest` users keep getting the double-registration conflict with the bili proxy.
- **Expected behavior**: merge this release PR → CI publishes v1.14.25 to npm `latest` → `@latest` installs self-disable.

## 4. Acceptance Criteria

- [x] Version bumped 1.14.24 → 1.14.25 (package.json + lockfile).
- [x] CHANGELOG.md + CHANGELOG.zh-CN.md carry a `### v1.14.25` entry.
- [x] devlog present (AGENTS.md §5.1.2); branch matches `*_release-v*` pattern for release.yml.
- [x] Pre-flight: build + tsc + full test suite green locally.
- [x] Release commit contains only release artifacts (package.json, lockfile, changelogs, devlog).

## 6. Milestones

- Single release PR; changes shipped: #335 only (3 commits on master since v1.14.24).
