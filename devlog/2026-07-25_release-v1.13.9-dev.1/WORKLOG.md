# WORKLOG: Release v1.13.9-dev.1

## Steps

1. Branched from latest master (`311a771`) — includes PR #180 (merged)
2. Bumped `package.json` version: `1.13.8-dev.1` → `1.13.9-dev.1`
3. Added changelog entries to `README.md` and `README.zh-CN.md`
4. Created devlog (REQ + WORKLOG)
5. Verified: typecheck clean, 851 tests pass, build clean

## CI Behavior

Per AGENTS.md §5.4.5: version `1.13.9-dev.1` contains a hyphen → CI publishes with `--tag dev` and marks GitHub Release as prerelease.

## Install (after merge)

```json
{ "plugin": { "opencode-acp": "dev" } }
```
