# WORKLOG — Slim: Remove manualMode + redundant commands + message compress mode

**Date**: 2026-07-29
**Branch**: `2026-07-29_slim-manualmode-commands-message`
**Base**: master (v1.14.7)

## Goal

Remove unused/disabled features to reduce codebase surface and DCP-derived code:
1. Message compress mode (`compress.mode: "message"`)
2. Manual mode (`manualMode` config + commands)
3. 5 redundant slash commands (`/acp manual`, `/acp recompress`, `/acp decompress`, `/acp stats`, `/acp help`)

## Changes

### Deleted files (7 source + 3 test)

**Source**:
- `lib/commands/manual.ts` (125 lines)
- `lib/commands/recompress.ts` (238 lines)
- `lib/commands/decompress.ts` (196 lines)
- `lib/commands/stats.ts` (152 lines)
- `lib/commands/help.ts` (75 lines)
- `lib/compress/message.ts` (300 lines)
- `lib/prompts/compress-message.ts` (35 lines)

**Tests**:
- `tests/compress-message.test.ts` (message-mode compress tests)
- `tests/compression-groups.test.ts` (decompress/recompress group tests)
- `tests/pipeline.test.ts` (manualMode-specific pipeline tests)

### Modified source files (16)

| File | Changes |
|------|---------|
| `index.ts` | Removed `createCompressMessageTool` import + mode check; always uses range tool |
| `lib/config.ts` | Removed `CompressMode` type, `mode` from CompressConfig, `ManualModeConfig` interface, `manualMode` from PluginConfig/defaultConfig/deepClone/merge, `mergeManualMode()` |
| `lib/config-validation.ts` | Removed `manualMode.*`, `compress.mode` from VALID_CONFIG_KEYS + type validation blocks |
| `lib/hooks.ts` | Removed imports of 7 deleted command handlers; simplified command dispatch to just `handleContextCommand`; removed `manual` param from `renderSystemPrompt()` |
| `lib/state/types.ts` | Removed `PendingManualTrigger` interface, `manualMode` + `pendingManualTrigger` from SessionState |
| `lib/state/state.ts` | Removed `manualModeDefault` param from `getOrCreate()` + `ensureSessionInitialized()`; removed manualMode from `createSessionState()` + `resetSessionState()` |
| `lib/compress/pipeline.ts` | Removed `manualMode` from CompressionSnapshot + snapshot/restore; removed manualMode block check in `prepareSession()`; removed manualMode reset in `finalizeSession()` |
| `lib/compress/decompress.ts` | Removed `config.manualMode.enabled` from `ensureSessionInitialized()` call |
| `lib/compress/index.ts` | Removed `createCompressMessageTool` export |
| `lib/commands/index.ts` | Simplified to only export `handleContextCommand` |
| `lib/prompts/store.ts` | Removed `compressMessage` from PromptKey/EditablePromptField/RuntimePrompts; removed manualExtension from INTERNAL_PROMPT_EXTENSIONS |
| `lib/prompts/index.ts` | Removed `manual` param from `renderSystemPrompt()` |
| `lib/prompts/extensions/system.ts` | Removed `MANUAL_MODE_SYSTEM_EXTENSION` constant |
| `lib/messages/inject/inject.ts` | Removed manualMode early return; removed message-mode condition guards |
| `lib/messages/inject/utils.ts` | Removed message-mode nudge rendering branches |
| `lib/messages/priority.ts` | `buildPriorityMap()` returns empty Map (message-mode body removed) |
| `lib/messages/query.ts` | `isProtectedUserMessage()` returns false (message-mode only feature) |

### Modified test files (~35)

- Batch-removed `manualMode: { enabled: false }` from buildConfig() factories
- Removed `manualMode: false` from state objects
- Removed `state.manualMode` mutations
- Removed `mode: "range"` from test compress configs
- Deleted individual tests for removed features (message-mode nudges, manualMode triggers, compress.mode validation, etc.)

### Modified docs (6)

- `AGENTS.md` — Removed `manualMode` from SessionState description
- `README.md` / `README.zh-CN.md` — Removed `manualMode` block + `"mode": "range"` from config examples
- `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md` — Removed `### manualMode` + `#### compress.mode` sections
- `TESTING.md` — Removed manualMode references
- `dcp.schema.json` — Removed `manualMode` + `compress.mode` schema sections

## Verification

- `tsc --noEmit`: PASS (0 errors)
- `npm test`: PASS (883 tests, 0 failures)
- `npm run build`: PASS (376.28 KB bundle)

## Impact

- **Lines removed**: ~1,657 source lines
- **Files deleted**: 7 source + 3 test
- **Tests removed**: ~18 (message-mode + manualMode-specific)
- **Net test count**: 901 → 883 (-18)
