# REQ — Release v1.14.2

## Purpose

Release v1.14.2 containing PR #210 (split protected ranges + soften last-user-message) and PR #208 (AGENTS.md §5.7 docs).

## Scope

- **PR #210**: In autonomous sessions, `buildCompressibleRanges` created one giant group whose endRef fell in the protected zone → zero recommendations → model could never compress. Fixed by splitting groups at the protected-zone boundary and softening `preserveLastUserMessage` from hard-reject to soft-filter.
- **PR #208**: Docs-only — AGENTS.md §5.7 nudge/growth test requirements + Docker E2E verification requirements.

## Version

1.14.1 → 1.14.2 (patch — bug fix release)

## Deliverables

- [x] Bump `package.json` version
- [x] Changelog entries in `README.md` and `README.zh-CN.md`
- [x] Devlog (this file + WORKLOG.md)
- [ ] Verify: typecheck + test + build + ci check
- [ ] Commit, push, create PR
- [ ] Human merges PR → CI auto-publishes
