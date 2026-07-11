# REQ - Release v1.11.3

- Task ID: `2026-07-11_release-v1.11.3`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background

PR #110 added `auto-tag.yml` workflow. This release publishes it to npm and tests the full automated pipeline: merge release PR → auto-tag → auto-publish.

## 2. Acceptance Criteria

- [x] `package.json` version bumped to 1.11.3
- [x] README.md + README.zh-CN.md changelog updated
- [x] devlog entry created
- [x] After merge: auto-tag.yml creates `v1.11.3` tag → release.yml auto-publishes
