# REQ: Release v1.12.0

## What

Release v1.12.0 — bundles all issue #23 fixes from branch `2026-07-11_compress-keep-ranges`.

## Changes in this release

- Baseline leak fix (`compressBaselineSet` lock + turn-wide compress scan)
- KEEP/REF markers
- Compressible ranges listing (replaces size-based recommendations)
- Compression Philosophy (5 bullets)
- `toolOutputReminder` removal
- `acp_status` default = ranges view
- Debug nudge feature
- `baselineCorrected` persistence fix
- Bug 14 cap (detailed notification: 10K)
- System prompt 5 fixes
- Multi-block notification empty summary fix
- Oracle reviewed

## Source

Branch `2026-07-11_compress-keep-ranges`, PR #115.
