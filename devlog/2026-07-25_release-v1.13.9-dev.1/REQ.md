# REQ: Release v1.13.9-dev.1

## Goal

Publish a dev prerelease (`opencode-acp@dev`) containing PR #180 (remove subagent history rewriting).

## Version

`1.13.9-dev.1` — published to npm `dev` tag (not `latest`).

## What's New Since v1.13.8-dev.1

- **PR #180**: Remove `injectExtendedSubAgentResults` — the code path that rewrote historical `<task_result>` tool outputs in the parent agent's message history, causing provider prefix-cache stalls. Deleted 2 files (156 lines), removed `subAgentResultCache` from `SessionState`. `experimental.allowSubAgents` still controls subagent ACP; only the parent-history rewriting is gone.

## Verification

- `npm run typecheck` — clean
- `npm test` — 851 pass / 0 fail
- `npm run build` — clean
- Dual-agent review: both APPROVE (Oracle + General)
