# WORKLOG — Release v1.14.3

1. Fetched master → confirmed PR #212 merged (`e77fb4e`)
2. Created release worktree
3. Bumped version 1.14.2 → 1.14.3
4. Added changelog entries
5. Created devlog
6. Committed, pushed, created PR

## Content

### PR #212 — Soften Protected Zone + Reduce Defaults
- `checkProtectedRange` hard-reject → `filterProtectedRecentMessages` soft-filter
- `preserveRecentMessages` default 20 → 5
- `preserveRecentTokens` default 20000 → 5000
- `dangerous` parameter now no-op
- 922/922 tests pass
