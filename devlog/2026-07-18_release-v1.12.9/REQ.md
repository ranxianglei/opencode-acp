# REQ: Release v1.12.9 — Compress-as-Anchor

## Motivation

PR #153 (compress-as-anchor) was merged to master. Need a stable release to publish the change to npm `latest`.

## Scope

Bundle PR #153 content into a stable release:
- Remove synthetic recap injection (`createSyntheticToolRecap`, `stripStaleCompressCalls`)
- Use `compress` tool calls as anchors (summary stays in `summary` parameter)
- `acp_context_recap` tool becomes manual-only
- Updated system prompt and tool descriptions

## Changes

- `package.json`: version `1.12.8` → `1.12.9`
- `README.md`: add v1.12.9 changelog entry
- `README.zh-CN.md`: add v1.12.9 changelog entry
- `devlog/2026-07-18_release-v1.12.9/`: REQ.md + WORKLOG.md

## Acceptance Criteria

- [x] typecheck passes (0 errors)
- [x] all tests pass
- [x] build succeeds
- [x] `check-pr.sh` passes
- [x] PR created with correct branch name
