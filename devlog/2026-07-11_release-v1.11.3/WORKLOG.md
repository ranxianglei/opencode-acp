# WORKLOG - Release v1.11.3

- Task ID: `2026-07-11_release-v1.11.3`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-11 18:20

## 1. Summary

Version bump to 1.11.3 to publish the auto-tag workflow (PR #110). This is also the first release to test the full automated pipeline: merge → auto-tag → release.yml → npm publish.

## 2. Change Log

- `package.json`: version 1.11.2 → 1.11.3
- `README.md`: v1.11.3 changelog entry
- `README.zh-CN.md`: v1.11.3 changelog entry
- `devlog/2026-07-11_release-v1.11.3/`: REQ.md + WORKLOG.md

## 3. What v1.11.3 Contains

- `auto-tag.yml` workflow (from PR #110): auto-creates version tag when release branch merged to master
- AGENTS.md Section 5.4: updated with auto-tag documentation
