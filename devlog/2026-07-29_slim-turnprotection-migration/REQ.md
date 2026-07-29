# REQ: Slim down — remove turnProtection + DCP migration code

## Motivation

ACP has accumulated dead/disabled features that add complexity without value. This PR removes two such features as part of a codebase slimming effort (Issue #30):

1. **turnProtection** — A config option (`turnProtection.enabled: false` by default) that protected the first N turns from tool cache modifications. Fully redundant with `preserveRecentMessages` which already protects recent messages from compression.

2. **DCP migration code** — Auto-migration paths (`dcp.jsonc → acp.jsonc`, `plugin/dcp/ → plugin/acp/`) that run on every startup. ACP has been the primary name for 8+ months; the migration window is closed.

## Scope

### turnProtection removal
- `lib/config.ts` — Remove `TurnProtection` interface, `turnProtection` field from `PluginConfig`, default config, `deepCloneConfig`, `mergeLayer`
- `lib/config-validation.ts` — Remove `turnProtection` from `VALID_CONFIG_KEYS`, type validation logic
- `lib/state/tool-cache.ts` — Remove turnProtection guard logic
- `dcp.schema.json` — Remove `turnProtection` schema section
- All test files — Remove `turnProtection` from `buildConfig()` factories
- `tests/config-validation.test.ts` — Delete turnProtection-specific validation tests
- Docs — Remove from README, CONFIGURATION, AGENTS.md, TESTING.md

### DCP migration removal
- `lib/config.ts` — Remove `dcp.jsonc → acp.jsonc` migration block in `getConfig()`
- `lib/state/persistence.ts` — Remove `dcp → acp` directory migration

## Impact

- ~50 lines of source code removed
- ~100 lines of test config boilerplate removed
- DCP-derived code reduced by ~45 lines
- Config surface simplified (one fewer config section)
