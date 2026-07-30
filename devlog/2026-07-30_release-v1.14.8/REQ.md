# REQ: Stable Release v1.14.8

## Requirement

Promote dev prereleases v1.14.8-dev.1 through v1.14.8-dev.3 to stable release v1.14.8.

## Scope

- Bump version to `1.14.8` (remove `-dev.3` suffix)
- Add comprehensive changelog to `README.md` and `README.zh-CN.md`
- Create devlog entry
- CI auto-publishes with `--tag latest` (version has no `-`)

## PRs Included (10 code PRs since v1.14.7)

- #232 — Remove dead turnProtection config + DCP migration
- #234 — Re-add /acp stats as acp_status wrapper
- #238 — E2E hardening (12 scenarios, observation recording)
- #239 — Pluggable message filter for third-party injection cleanup
- #240 — Orphan message splicing (structural-only parts)
- #241 — System token breakdown + hide context fill %
- #242 — keepLastOnly dedup + OMO builtin filters
- #244 — acp_status hides consumed compress from PROTECTED list
- #245 — Re-add HOW_TO_COMPRESS_RULES to nudge
- #248 — Tool pair integrity (auto-extend ranges)
