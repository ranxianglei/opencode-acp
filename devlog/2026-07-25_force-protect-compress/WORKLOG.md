# WORKLOG: Force-Protect "compress" Tool

## Changes

### `lib/config.ts`
- Added `FORCE_COMPRESS_PROTECTED = ["compress"]` constant with documentation explaining the data-loss rationale
- Modified `mergeCompress()` line 447-449: when user provides an explicit `protectedTools` array, `FORCE_COMPRESS_PROTECTED` is spread into the Set to guarantee "compress" survives

### `tests/config-protected-tools.test.ts`
- Updated all 6 existing tests to reflect force-protection behavior:
  - `["task"]` → `["task", "compress"]`
  - `[]` → `["compress"]`
  - `["skill", "compress"]` → `["skill", "compress"]` (no duplication)
  - Multi-layer chaining tests updated

### `README.md` + `README.zh-CN.md`
- Added note in default config comment: "compress" is always force-protected
- Updated Protected Tools section: documented that `[]` protects only `compress`, explicit arrays always include `compress`

## Verification
- `npm run typecheck`: PASS
- `npm run test`: 843 tests pass (5 updated + 1 new behavior verified)
- `npm run build`: PASS
