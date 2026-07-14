# WORKLOG: Protection-Aware Compressible Ranges & Stats

## Changes

### `lib/messages/inject/utils.ts`
- Added import: `messageContainsProtectedTool` from `../../compress/protected-content`
- `estimateContextComposition`: Added optional `protectedTools` + `protectedFilePatterns` params, tracks `protectedTokens`
- `buildCompressibleRanges`: Added optional `protectedTools` + `protectedFilePatterns` params, skips protected messages
- `ContextComposition`: Added `protectedTokens: number` field

### `lib/messages/inject/inject.ts`
- Pass `config.compress.protectedTools` + `config.protectedFilePatterns` to both functions
- Nudge breakdown now shows: "⚠️ X tokens protected — not compressible. Effective compressible: ~Y"

### `lib/compress/status.ts`
- Both `renderOverview` and `renderUncompressedRanges` pass protection params
- Defensive access (`ctx.config?.compress?.protectedTools ?? []`) for test mocks

### `tests/protection-aware-stats.test.ts` (NEW, 6 tests)
- `buildCompressibleRanges` excludes protected tools
- `buildCompressibleRanges` includes all when no protection configured
- `buildCompressibleRanges` respects `protectedFilePatterns`
- `estimateContextComposition` tracks `protectedTokens`
- `estimateContextComposition` returns 0 protected when no tools protected
- Backward compat: no protection params = no tracking

## Test Results
- TypeScript: pass
- Tests: 672 pass, 0 fail
