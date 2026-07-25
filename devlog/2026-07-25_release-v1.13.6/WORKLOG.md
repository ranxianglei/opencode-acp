# WORKLOG — v1.13.6 Release

## Steps

1. **Fetched latest master** — `git fetch github master` → HEAD at `9670543` (PR #188 merged).
2. **Created release worktree** — `/home/dog/projects/opencode-acp-release-v1.13.6`, branch `2026-07-25_release-v1.13.6`.
3. **Bumped version** — `package.json` 1.13.5 → 1.13.6.
4. **Added changelog entries**:
   - `README.md`: `### v1.13.6 — Force-Protect Compress Tool Regardless of User Config (PR #188)` inserted before v1.13.5 entry.
   - `README.zh-CN.md`: Chinese translation of the same entry.
5. **Created devlog** — `devlog/2026-07-25_release-v1.13.6/REQ.md` + `WORKLOG.md`.
6. **Verification** — (pending: typecheck + test + build + CI check)
7. **Commit + push + PR** — (pending)

## What This Release Ships

PR #188: Added `FORCE_COMPRESS_PROTECTED = ["compress"]` constant in `lib/config.ts`.
In `mergeCompress()`, when a user provides an explicit `protectedTools` array, the
constant is spread into the Set to guarantee `"compress"` survives any override.
Even `protectedTools: []` now resolves to `["compress"]`.

This closes the data-loss vector where users could accidentally remove compress
protection via the replace-merge policy from PR #177.

## Test Count

846 tests pass (per PR #188 verification — no source changes in this release PR).
