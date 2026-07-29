# REQ: Slim down — remove manualMode + redundant commands + message compress mode

## Motivation

Continuation of Issue #30 codebase slimming. Removes three unused/disabled features:

1. **manualMode** — Disabled by default (`manualMode.enabled: false`). When enabled, compression only runs via explicit `/acp manual` command instead of autonomous nudges. Deeply embedded across 17 source files but never used in production.

2. **Redundant slash commands** — `/acp recompress`, `/acp decompress`, `/acp stats`, `/acp help` are rarely used. Keep only `/acp context` (the primary diagnostic command).

3. **Message compress mode** — `compress.mode: "message"` is never used. Range mode is the default and the only documented mode. Message mode adds complexity (separate prompt, separate compress handler) with zero value.

## Scope

### Files deleted (7)
- `lib/commands/manual.ts` — manual mode command handler
- `lib/commands/recompress.ts` — /acp recompress
- `lib/commands/decompress.ts` — /acp decompress
- `lib/commands/stats.ts` — /acp stats
- `lib/commands/help.ts` — /acp help
- `lib/compress/message.ts` — message-mode compress handler
- `lib/prompts/compress-message.ts` — message-mode compress prompt

### Source changes
- `lib/config.ts` — Remove ManualModeConfig type, manualMode field, CompressMode type, compress.mode field
- `lib/config-validation.ts` — Remove manualMode + compress.mode validation
- `lib/state/types.ts` — Remove manualMode from SessionState
- `lib/state/state.ts` — Remove manualMode initialization
- `lib/hooks.ts` — Remove manual command handler, applyPendingManualTrigger, simplify command dispatch
- `lib/compress/pipeline.ts` — Remove manualMode checks
- `lib/messages/inject/inject.ts` — Remove manualMode nudge suppression
- `lib/commands/index.ts` — Remove deleted command exports
- `lib/commands/compression-targets.ts` — May reference manualMode
- `lib/prompts/index.ts` — Remove compress-message import
- `lib/prompts/extensions/system.ts` — Remove manual mode system prompt text
- `lib/prompts/extensions/nudge.ts` — Remove manual mode references
- `lib/prompts/store.ts` — Remove manual mode prompt references
- `dcp.schema.json` — Remove manualMode + compress.mode schema
- Docs — Remove from AGENTS.md, CONFIGURATION.md, CONFIGURATION.zh-CN.md, README.md, README.zh-CN.md

### Test changes
- Remove `manualMode: { ... }` from buildConfig() factories (~35 files)
- Delete dedicated manualMode test cases
- Delete or update message-mode test cases
