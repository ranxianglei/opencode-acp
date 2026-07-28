# WORKLOG: Configuration Documentation

## Timeline

### 2026-07-28

1. Created branch `2026-07-28_config-documentation` from master (`9adf0a9`)
2. Read `lib/config.ts` — extracted all type definitions, default values, and inline comments
3. Read `lib/config-validation.ts` — extracted `VALID_CONFIG_KEYS` set (authoritative list of all accepted config keys)
4. Wrote `CONFIGURATION.md` — comprehensive reference covering:
   - Config file locations (3-layer merge + legacy DCP migration)
   - Quick-start example
   - All 60+ parameters organized by section:
     - General (6 params)
     - commands (2 params)
     - manualMode (1 param)
     - turnProtection (2 params)
     - experimental (2 params)
     - compress (26 params)
     - gc (7 params, with DEPRECATED/ACTIVE status markers)
     - qualityGate (3+ params)
   - Common recipes (5 examples)
   - Removed parameters table
   - Config validation note
5. Updated README.md — added link to CONFIGURATION.md under Configuration section
6. Updated README.zh-CN.md — added link to CONFIGURATION.md under 配置 section
7. Created devlog entry

## Files Changed

- `CONFIGURATION.md` — NEW (comprehensive config reference)
- `README.md` — Added link to CONFIGURATION.md (1 line)
- `README.zh-CN.md` — Added link to CONFIGURATION.md (1 line)
- `devlog/2026-07-28_config-documentation/REQ.md` — NEW
- `devlog/2026-07-28_config-documentation/WORKLOG.md` — NEW

## Key Decisions

- **Status markers**: Each parameter gets ACTIVE / DEPRECATED / EXPERIMENTAL status to help users understand which params have effect vs which are no-ops kept for backward compat
- **DEPRECATED params**: `gc.algorithm`, `gc.maxBlockAge` are kept in config for backward compat but have no effect
- **Emergency truncation**: Documented that `gc.majorGcThresholdPercent` now triggers tool-output truncation (not summary truncation which was removed in v1.14.4)
- **No code changes**: This PR is documentation-only; no tests need to run
