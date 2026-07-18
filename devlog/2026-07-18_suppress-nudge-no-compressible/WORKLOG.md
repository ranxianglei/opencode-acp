# WORKLOG: Suppress Nudge When All Content Is Protected

## Changes

### `lib/messages/inject/inject.ts`
- Added `allProtected` check: `compressible.length === 0 && protected.length > 0`
- Combined with existing `filterSuppressed` into `nothingToCompress`
- `shouldInject` now suppresses when `nothingToCompress` (unless emergency override)

### `tests/inject.test.ts`
- Added test: "nudge suppressed when all content is protected (nothing to compress)"
- Added test: "emergency override fires even when all content is protected"

## Verification

- TypeScript: 0 errors
- Tests: 752/752 pass (750 existing + 2 new)
- Node v25.9.0
