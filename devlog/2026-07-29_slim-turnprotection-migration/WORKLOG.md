# WORKLOG: Slim down — remove turnProtection + DCP migration code

## Changes

### turnProtection removal
- `lib/state/tool-cache.ts`: Removed turnProtection guard (turnProtectionEnabled/turnProtectionTurns/isProtectedByTurn, ~14 lines)
- `lib/config.ts`: Removed TurnProtection interface, turnProtection from PluginConfig/defaultConfig/deepCloneConfig/mergeLayer
- `lib/config-validation.ts`: Removed turnProtection from VALID_CONFIG_KEYS (3 entries) + type validation block (~30 lines)
- `dcp.schema.json`: Removed turnProtection schema section
- `tests/config-validation.test.ts`: Removed 4 turnProtection-specific test cases, updated 2 remaining tests to use other config sections
- 28 other test files: Removed `turnProtection: { enabled: false, turns: 4 }` from buildConfig() factories
- `AGENTS.md`, `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md`, `README.md`, `README.zh-CN.md`, `TESTING.md`: Removed turnProtection documentation

### DCP migration removal
- `lib/config.ts`: Removed LEGACY_GLOBAL_CONFIG_PATH constants, dcp.jsonc/json fallback paths in getConfigPaths(), createDefaultConfig() migration block, getConfig() migration block. Removed unused `copyFileSync` import.
- `lib/state/persistence.ts`: Removed getLegacyStorageDir(), migrateFromLegacyIfNeeded(), calls from ensureStorageDir() and writePersistedSessionState(). Removed unused cpSync/existsSyncSync import.
- `lib/prompts/store.ts`: Removed dcp-prompts → acp-prompts migration block (`legacyGlobalRoot` + `cpSync`). Removed unused `cpSync` import.
- Docs: Updated README.md "Migrating from DCP" section (removed auto-migration claims, added manual migration commands), README.zh-CN.md, CONFIGURATION.md/zh-CN (removed "auto-migrated on first load" line), AGENTS.md (removed migration from module map, config paths, storage paths table, bug fix history), TESTING.md (removed migration from module descriptions).

## Verification
- `tsc --noEmit`: PASS (0 errors)
- `node --import tsx --test tests/*.test.ts`: 915/915 PASS (0 failures)
- Zero remaining `turnProtection` references in lib/ or tests/
- Zero remaining DCP migration references in lib/
