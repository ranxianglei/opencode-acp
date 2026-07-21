# REQ - Release v1.13.2

- Task ID: `2026-07-21_release-v1.13.2`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-21

## Goal

Ship PR #169 (preserve-last-user-msg + config defaults tuning) as v1.13.2.

## Scope

Patch release bundling:
1. **preserve-last-user fix** — `filterCompressedRanges` restores the most
   recent pruned user message when all visible user messages fall in compressed
   ranges. Prevents zhipuai-lb code 1214 freeze (second path after v1.13.1).
2. **pruneNotification default `"off"`** — toast on every compress was
   over-intrusive; events still logged via always-log path.
3. **maxSummaryLengthHard default 20000** (was 10000) — old cap rejected ~25%
   of useful dense summaries.
4. **dcp.schema.json sync** — 4 stale defaults aligned with code.

## Compatibility

- Persisted state format: unchanged.
- Config: 3 default values change. Users with explicit config unaffected.
  - `pruneNotification`: `"detailed"` → `"off"`
  - `pruneNotificationType`: `"chat"` → `"toast"` (old debt)
  - `compress.maxSummaryLengthHard`: `10000` → `20000`

## Exit Criteria

- [x] Version bumped in package.json
- [x] Changelog entries in README.md + README.zh-CN.md
- [x] Devlog created
- [x] CI checks pass (branch name, devlog, changelog)
- [ ] PR merged (human confirmation)
- [ ] npm published (automated via release.yml)
