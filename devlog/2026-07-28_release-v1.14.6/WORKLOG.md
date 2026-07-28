# WORKLOG — v1.14.6 Release

## 2026-07-28

1. Created release branch `2026-07-28_release-v1.14.6` from master `becee35` (PR #226 merged)
2. Bumped `package.json` version: `1.14.5 → 1.14.6`
3. Added changelog entry to `README.md` (v1.14.6 section)
4. Added changelog entry to `README.zh-CN.md` (v1.14.6 section)
5. Created devlog entry
6. Verified build + typecheck + tests
7. Created PR

## Bundled PR

- PR #226: Debug nudge chat visibility — `lib/hooks.ts` `debugNotify` callback now persists full nudge text to conversation DB when `config.debug` is on, making nudge injections visible in the chat UI for debugging.
