# WORKLOG: Release v1.13.0

## Commits

| Commit | Description |
|--------|-------------|
| `2026-07-14` | release: v1.13.0 — bump version, changelog, devlog |

## Changes

### Version Bump
- `package.json`: 1.12.1 → 1.13.0

### Changelog
- `README.md`: Added v1.13.0 entry under "## Changelog"
- `README.zh-CN.md`: Added v1.13.0 entry under "## 更新日志"

### Devlog
- `devlog/2026-07-14_release-v1.13.0/REQ.md` — release requirements
- `devlog/2026-07-14_release-v1.13.0/WORKLOG.md` — this file

## Release Contents (from PR #126)

### Bug 2: sync.ts carve-out removal (issue #125 primary fix)
- Removed `lib/messages/sync.ts:54-66` carve-out that kept blocks active when anchor was externally deleted
- Root cause: `syncCompressionBlocks` runs on raw messages (hooks.ts:250) before `filterCompressedRanges` (hooks.ts:262), so ACP-hidden anchors are still present — carve-out only triggered for externally-deleted anchors → empty LLM requests

### Bug 1: Compress snapshot/rollback (defensive)
- Added `snapshotCompressionState()` / `restoreCompressionState()` to `lib/compress/pipeline.ts`
- Wrapped mutation phase in try/catch in `lib/compress/range.ts` and `lib/compress/message.ts`
- Captures `prune.messages`, `stats`, and `manualMode` via `structuredClone`

## Test Results
- TypeScript: ✅ pass
- Tests: ✅ 643 pass, 0 fail
- Build: ✅ success

## Post-Merge
- `release.yml` will auto-tag `v1.13.0`, build, test, publish to npm, create GitHub Release
