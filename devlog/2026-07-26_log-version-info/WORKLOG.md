# Worklog: Log Version Info

## Implementation
1. `tsup.config.ts`: Import `package.json`, add `define: { ACP_VERSION: JSON.stringify(pkg.version) }`
2. `lib/logger.ts`:
   - `declare const ACP_VERSION` (build-time injected)
   - `LOG_VERSION` constant (falls back to `"dev"` when not bundled, e.g. tsx tests)
   - Daily log line: append `| v={LOG_VERSION}`
   - Context log: write `_version` file on first snapshot per session

## Verification
- typecheck ✅ | build ✅ | 919 tests pass ✅
- Bundle verified: `LOG_VERSION` × 4 occurrences in dist/index.js
