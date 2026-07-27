# WORKLOG — Release v1.14.2

## Timeline

1. Fetched master → confirmed PR #210 merged (`5b91c3e`)
2. Created release worktree from `github/master`
3. Bumped `package.json`: 1.14.1 → 1.14.2
4. Added changelog entries to README.md and README.zh-CN.md
5. Created devlog REQ.md + WORKLOG.md
6. (pending) Verify + commit + push + PR

## Content

### PR #210 — Split Protected Ranges + Soften Last-User-Message

**Root cause**: In autonomous sessions (1 user msg + many assistant msgs), `buildCompressibleRanges` grouping only breaks on user messages. Tool results are `assistant` role in OpenCode → one giant group whose endRef falls in protected zone → `excludeProtectedRanges` removes entire range → zero recommendations → nudge suppressed.

**Fix**:
1. `buildCompressibleRanges` gains `protectedZoneRefs` param → splits groups at protected-zone boundary
2. `preserveLastUserMessage` moves from hard-reject (`checkProtectedRange`) to soft-filter (`filterLastUserMessage`)
3. `allInProtectedZone` added to `nothingToCompress`
4. Review fixes: stale error messages + empty-plan guard (commit `08dc4a5`)

**Verification**: 922/922 tests pass, typecheck clean, dual-agent review (both APPROVE)

### PR #208 — Docs Only

AGENTS.md §5.7: nudge/growth testing requirements (multi-turn, side-effect assertions, production config, growth cycle) + Docker E2E requirements. No source code changes.

## Files Changed

- `package.json` — version bump
- `README.md` — v1.14.2 changelog entry
- `README.zh-CN.md` — v1.14.2 changelog entry
- `devlog/2026-07-27_release-v1.14.2/REQ.md` — this release ticket
- `devlog/2026-07-27_release-v1.14.2/WORKLOG.md` — this file
