# WORKLOG: Message Filter

## Phase 1: Module structure

Created `lib/messages/filter/`:
- `types.ts` — MessageFilter, MessageFilterContext, FilterResult, MessageFiltersConfig
- `registry.ts` — singleton Map, register/get/list/clear
- `apply.ts` — `applyMessageFilters(messages, config, logger, ctx)` iterates messages × parts × filters
- `builtin/omo-system-reminder.ts` — strips `<system-reminder>` blocks + `<!-- OMO_INTERNAL_INITIATOR -->` markers
- `builtin/index.ts` — `ensureBuiltinFiltersRegistered()` (check-and-register, idempotent)
- `index.ts` — barrel export

## Phase 2: Config integration

- `lib/config.ts`: Added `MessageFiltersConfig` interface, default config (`enabled: true`, `omo-system-reminder: { enabled: true }`), `mergeMessageFilters()`, clone in deepClone, added to `mergeLayer()`
- `lib/config-validation.ts`: Added `messageFilters`, `messageFilters.enabled`, `messageFilters.filters` to `VALID_CONFIG_KEYS`

## Phase 3: Pipeline integration

`lib/hooks.ts`:
- Added imports: `applyMessageFilters` from `./messages/filter/apply`, `ensureBuiltinFiltersRegistered` from `./messages/filter/builtin`
- Pipeline position: after `stripHallucinations`, before `cacheSystemPromptTokens` / `assignMessageRefs`
- Passes session context: sessionId, isSubAgent, modelContextLimit

## Phase 4: Tests

`tests/message-filter.test.ts` — 20 tests:
- Registry: register, get, list, re-register same version, version conflict
- applyMessageFilters: disabled config, no filters, drop, modify, disabled filter, error catching, non-text/empty skip
- OMO filter: normal keep, assistant keep, drop-only-block, modify-with-content, lone-reminder, lone-marker, multiple blocks, empty-after-strip
- ensureBuiltinFiltersRegistered: registers OMO, idempotent

## Verification

- typecheck: 0 errors
- tests: 915/915 pass (895 existing + 20 new)
- build: 383.74 KB
