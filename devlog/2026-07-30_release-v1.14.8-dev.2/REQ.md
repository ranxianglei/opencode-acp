# REQ: Dev Prerelease v1.14.8-dev.2

## Objective

Publish a dev prerelease covering the 2 PRs merged since v1.14.8-dev.1 (master at de1d99f).

## Scope

Version: `1.14.8-dev.2` (contains `-` → CI publishes with `--tag dev`, GitHub Release marked as prerelease).

**PRs included** (#244–#245):
- #244 — Fix: acp_status hides consumed compress calls from PROTECTED list
- #245 — Fix: re-add HOW_TO_COMPRESS_RULES to nudge injection for high-attention summary guidance

## Deliverables

- [x] `package.json` version bumped to `1.14.8-dev.2`
- [x] `README.md` changelog entry
- [x] `README.zh-CN.md` changelog entry
- [x] `devlog/2026-07-30_release-v1.14.8-dev.2/REQ.md` + `WORKLOG.md`
- [ ] CI checks pass
- [ ] PR created

## Installation

```bash
opencode plugin opencode-acp@dev --global
```
