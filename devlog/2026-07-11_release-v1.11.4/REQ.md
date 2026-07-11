# REQ - Release v1.11.4

- Task ID: `2026-07-11_release-v1.11.4`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background

Release v1.11.4 includes PR #112 (baseline persistence fix) and PR #113 (unified release workflow). This is the first release to test the unified `release.yml` — merge release PR → auto-tag + auto-publish in one workflow.

## 2. Acceptance Criteria

- [x] `package.json` version bumped to 1.11.4
- [x] README.md + README.zh-CN.md changelog updated
- [x] devlog entry created
- [x] After merge: release.yml auto-tag + auto-publish (no manual steps)
