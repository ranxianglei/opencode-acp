# WORKLOG: Release v1.14.7

## Steps
1. Created release branch `2026-07-28_release-v1.14.7` from master (`49e041a`)
2. Bumped `package.json` version: 1.14.6 → 1.14.7
3. Added changelog entry to `README.md` (v1.14.7 section)
4. Added changelog entry to `README.zh-CN.md` (v1.14.7 section)
5. Created devlog entry

## Bundled
- PR #228: Deduplicate HOW_TO_COMPRESS_RULES — removed from breakdown block + 3 nudge templates, kept in system prompt + rejection message. Saves 2.4-3.6K tokens per nudge turn. Oracle-verified no regression.
