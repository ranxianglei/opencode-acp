# REQ: Release v1.12.6

## Summary

Patch release bundling the stale `contextLimitAnchors` fix:

- **PR #143** — Stale `contextLimitAnchors` cleared when context drops below `maxLimit` without a compress call

## Motivation

After v1.12.5, a session (`ses_0a3be0cdeffezb9pLzfifH7lzK`) showed "⚠️ Context limit reached" nudges at only ~10% context usage (103.5K of 1M model limit). Root cause: `contextLimitAnchors` were added when `overMaxLimit=true` but only cleared on a compress tool call in the current turn (`currentTurnHasCompress`). If context dropped below `maxLimit` via another mechanism (OpenCode compaction, external message deletion), the anchors stayed stale → `applyAnchoredNudges` kept injecting the static "Context limit reached" template.

PR #143 adds an `else` branch that clears `contextLimitAnchors` whenever `!overMaxLimit`, symmetric with the existing `!overMinLimit` → clear turn/iteration anchors logic. Dual-agent reviewed (Oracle + independent reviewer, both APPROVE). 691 tests pass.

## Changes

- `package.json`: version `1.12.5` → `1.12.6`
- `README.md` / `README.zh-CN.md`: changelog entries for v1.12.6

## Verification

- CI check (`scripts/ci/check-pr.sh`) must pass
- No code changes — release-only PR
