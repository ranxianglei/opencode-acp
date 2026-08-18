# REQ — v1.14.22: stable system prompt token estimate (#255)

## Problem

Patch release shipping the #255 fix (merged as `d24b175`, PR #322): after ACP
compression removes the true first assistant message from visible history,
nudge and `acp_status` each re-derived the system prompt token estimate from
the first *visible* assistant — a late turn whose input includes large
accumulated history. Both inflated the estimate and diverged from each other.

## Content since v1.14.21

- `d24b175` Merge PR #322 — `fix: stabilize system prompt token estimate (#255)`:
  write-if-undefined guard in `cacheSystemPromptTokens` (`lib/ui/utils.ts`);
  cache preference in `estimateContextComposition` (`lib/messages/inject/utils.ts`)
  and `collectVisibleMessages` (`lib/compress/status.ts`). 1010 tests pass;
  Docker E2E 12/12.
- `0a364e1` Merge PR #320 — `feat(repo): move changelog to separate files`
  (closes #318). Repo hygiene only; no plugin runtime changes.

## Acceptance

- All existing tests pass
- Version bump on this release branch only; `CHANGELOG.md` and
  `CHANGELOG.zh-CN.md` updated with `### v1.14.22`
- `./scripts/ci/check-pr.sh` green
- release.yml publishes v1.14.22 to npm `latest` after merge
