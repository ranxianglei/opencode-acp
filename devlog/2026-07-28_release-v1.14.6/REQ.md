# REQ — v1.14.6 Release

## Goal

Release v1.14.6 bundling PR #226 (debug nudge chat visibility).

## Context

PR #226 was merged after v1.14.5. This is a small release to ship the single change.

## Changes

- PR #226: `lib/hooks.ts` — `debugNotify` callback now persists full nudge text to conversation DB via `sendIgnoredMessage()` when `config.debug` is on. User-visible, model-invisible (`ignored: true`). Prefix `[ACP Debug Nudge]`.

## Acceptance Criteria

- [x] Version bumped to 1.14.6
- [x] Changelog entries added to README.md and README.zh-CN.md
- [x] Devlog created
- [x] Build + typecheck + tests pass
- [ ] PR created
- [ ] Human merge
