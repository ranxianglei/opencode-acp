# REQ - Release v1.11.2

- Task ID: `2026-07-11_release-v1.11.2`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background & Problem Statement

- v1.11.1 released the compress baseline fix. v1.11.2 releases the CI enforcement (PR #104) to npm registry.
- This is the first release using the new tag-triggered auto-publish workflow.

## 2. Acceptance Criteria

- [x] `package.json` version is `1.11.2`
- [x] README.md + README.zh-CN.md changelog updated
- [x] Devlog entry exists
- [x] Tag `v1.11.2` triggers `release.yml` auto-publish
