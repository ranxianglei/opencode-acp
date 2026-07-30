# REQ: Dev Prerelease v1.14.8-dev.1

## Objective

Publish a dev prerelease covering the 7 PRs merged since v1.14.7 (master at f842e3f).

## Scope

Version: `1.14.8-dev.1` (contains `-` → CI publishes with `--tag dev`, GitHub Release marked as prerelease).

**PRs included** (#238–#242):
- #238 — E2E hardening (observation recording, T2 cadence regression, consumed-call hiding, auxiliary call filtering)
- #232 — Refactor: remove dead turnProtection + DCP migration code
- #234 — Re-add /acp stats as acp_status wrapper
- #239 — Pluggable message filter for third-party injection cleanup
- #240 — Fix: splice orphan messages with only structural parts after consumed compress removal
- #241 — System token breakdown in acp_status + nudge; hide context fill; consolidate duplicate estimations
- #242 — keepLastOnly dedup mechanism + 4 OMO builtin filters

## Deliverables

- [x] `package.json` version bumped to `1.14.8-dev.1`
- [x] `README.md` changelog entry
- [x] `README.zh-CN.md` changelog entry
- [x] `devlog/2026-07-30_release-v1.14.8-dev/REQ.md` + `WORKLOG.md`
- [ ] CI checks pass
- [ ] PR created

## Installation

```bash
opencode plugin opencode-acp@dev --global
```
