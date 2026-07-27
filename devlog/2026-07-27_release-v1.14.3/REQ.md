# REQ — Release v1.14.3

## Purpose

Hotfix release for PR #212: soften protected zone (filter instead of reject) + reduce defaults.

## Scope

- **PR #212**: `checkProtectedRange` hard-reject → `filterProtectedRecentMessages` soft-filter. `preserveRecentMessages` 20→5, `preserveRecentTokens` 20000→5000.

## Version

1.14.2 → 1.14.3 (patch — hotfix)
