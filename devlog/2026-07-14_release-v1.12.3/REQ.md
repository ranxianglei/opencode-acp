# REQ: Release v1.12.3

## Problem Statement

PR #130 (regex tag fragment leak fix for issue #123) has been merged to master. A release is needed to publish the fix to npm.

## Changes in v1.12.3

Three regex fixes in `lib/messages/utils.ts`:
- `DCP_PAIRED_TAG_REGEX` (line 14): `]*>` matched any `>` — tag fragments leaked into chat
- `DCP_BLOCK_ID_TAG_REGEX` (line 11): `(])` required literal `]` — `replaceBlockIdsWithBlocked` was a no-op
- `DCP_MESSAGE_REF_TAG_REGEX` (line 13): Missing opening tag — fragments in compression summaries

## Acceptance Criteria

- [x] Version bumped to 1.12.3 in `package.json`
- [x] Changelog updated in `README.md` and `README.zh-CN.md`
- [x] Devlog entry created
- [ ] PR merged → auto-publish via `release.yml`
