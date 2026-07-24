# REQ: Release v1.13.4

Release PR for the compress-call protection fix (PR #185).

## What's in this release

- **PR #185**: `fix: protect compress tool calls from being compressed`
  - Added `"compress"` to `COMPRESS_DEFAULT_PROTECTED_TOOLS` in `lib/config.ts`
  - 6 new tests in `tests/protect-compress-calls.test.ts`
  - Synced stale defaults in `dcp.schema.json`, `README.md`, `README.zh-CN.md`

## Version bump

1.13.3 → 1.13.4 (patch — bug fix)
