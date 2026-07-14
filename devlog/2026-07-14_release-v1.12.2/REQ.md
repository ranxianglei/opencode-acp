# REQ: Release v1.12.2

## Problem Statement

PR #126 (compress failure rollback + sync carve-out removal) has been merged to master. A release is needed to publish the fix to npm.

## Changes in v1.12.2

- **Bug 2 (sync.ts carve-out removal)**: Fix for issue #125 — externally-deleted anchors kept blocks active, hiding messages without recap injection → empty LLM requests.
- **Bug 1 (compress snapshot/rollback)**: Defensive fix — compress tool mutations are now wrapped in try/catch with state snapshot/rollback via `structuredClone`. On failure, state (including `manualMode`) is restored — no ghost blocks.

## Acceptance Criteria

- [x] Version bumped to 1.12.2 in `package.json`
- [x] Changelog updated in `README.md` and `README.zh-CN.md`
- [x] Devlog entry created
- [x] CI checks pass (`pr-checks.yml` + `ci.yml`)
- [ ] PR merged → auto-publish via `release.yml`

## Constraints

- Branch name MUST follow `YYYY-MM-DD_release-v{VERSION}` for auto-tagging
- All tests must pass
- `npm run check:package` must pass
