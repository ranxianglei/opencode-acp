# WORKLOG: Release v1.12.3

## Commits

| Commit       | Description                                              |
| ------------ | -------------------------------------------------------- |
| `2026-07-14` | release: v1.12.3 — regex tag fragment leak fix (PR #130) |

## Changes

### Version Bump

- `package.json`: 1.12.2 → 1.12.3

### Changelog

- `README.md`: Added v1.12.3 entry
- `README.zh-CN.md`: Added v1.12.3 entry

### Devlog

- `devlog/2026-07-14_release-v1.12.3/` (REQ.md + WORKLOG.md)

## Release Contents (from PR #130, issue #123)

Three regex fixes in `lib/messages/utils.ts`:

1. `DCP_PAIRED_TAG_REGEX` (line 14): `]*>` → `<(?:dcp|acp)[^>]*>` (PR #124's fix, extended)
2. `DCP_BLOCK_ID_TAG_REGEX` (line 11): `(])` → `(<(?:dcp|acp)-message-id[^>]*>)` (was complete no-op)
3. `DCP_MESSAGE_REF_TAG_REGEX` (line 13): added opening tag match (was leaving fragments)

Tests: `tests/regex-tag-leak.test.ts` (NEW, 23 tests). Total: 666 pass.

## Post-Merge

- `release.yml` will auto-tag `v1.12.3`, build, test, publish to npm, create GitHub Release
