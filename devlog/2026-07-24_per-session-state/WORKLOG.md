# WORKLOG - Per-Session State Registry

- Task ID: `2026-07-24_per-session-state`
- Branch: `2026-07-24_per-session-state` (base: master be0f116 / v1.13.3)
- Started: 2026-07-24

## Investigation (prior session, summarized)
- Root cause confirmed from `sst/opencode` dev HEAD `adba484d`: `experimental.chat.system.transform` DOES fire for subagent chat completions on the same dispatch path as the parent, and `input.model.limit.context` IS populated (required field on `Provider.Model`). Dispatch: task tool → child session (parentID) → ops.prompt → handle.process → processor → llm.stream → `session/llm/request.ts:69-73`.
- The subagent's `modelContextLimit` is lost because the shared ACP `SessionState` singleton is reset on every session switch (`resetSessionState` wipes it), and `system.transform` (which sets it) fires after `messages.transform` (which reads+saves), so it is never persisted for interleaved subagents.

## Implementation
- [x] Branch + devlog created.
- [x] `lib/state/state.ts`: added `SessionStateRegistry` (Map<sessionId,SessionState> + shared `compressionTiming` + soft cap 32, eviction oldest-first); added `updatePerTurnState` (compaction detection + currentTurn) extracted from `checkSession`; removed `checkSession`.
- [x] `index.ts`: `new SessionStateRegistry(logger)`; handlers + compress tool factory context take the registry.
- [x] `lib/hooks.ts`: all 4 handlers resolve state per-call. messages.transform resolves via `registry.getOrCreate(lastUserMessage.info.sessionID)` then `updatePerTurnState`; keeps `INTERNAL_AGENT_NAMES` + `!lastUserMessage` early structure. When there is no resolvable user message, an ephemeral state keeps state-independent stages (e.g. `stripHallucinations`) running (matches pre-refactor behavior).
- [x] `lib/compress/types.ts`: added `ToolFactoryContext` + `resolveToolContext(factoryCtx, sessionID)`.
- [x] `lib/compress/{range,message,decompress,prune-tool,recap,search,status}.ts`: factory param is now `ToolFactoryContext`; `resolveToolContext` runs at execute entry. Compress modules unchanged (still take resolved `ToolContext`).
- [x] `lib/compress/pipeline.ts`: unchanged — `ensureSessionInitialized` is now an idempotent safety no-op.
- Per user directive (@dog): **no** suppress-nudge/modelContextLimit-unknown safety net was added — keep observing the behavior in this first revision.

## Tests
- [x] `tests/registry-stub.ts` (new): `singletonRegistry(state)` (compress-tool unit tests) + `createTestRegistry(state)` (hook-handler tests, supports `getOrCreate` + session-switch).
- [x] Updated 13 test files: compress-tool factories use `singletonRegistry(state)`; hook handlers use `createTestRegistry(state)`; command-handler direct calls still pass `state` (resolved in `createCommandExecuteHandler`).
- [x] Rewrote `session switch` test (e2e-blocks-nudges) — old shared-singleton "reset" assertion is obsolete under per-session state; now asserts session A's state is preserved when session B runs (the #33 fix).

## Verification
- [x] `node ./node_modules/typescript/bin/tsc --noEmit` clean (exit 0).
- [x] `npm run build` clean (exit 0; dist/index.js 434.76 KB).
- [x] `node --import tsx --test tests/*.test.ts` — **837 pass, 0 fail**.
- [ ] Deploy locally (`scripts/dev-deploy.sh`); observe subagent `modelContextLimit` now populated across interleaved sessions.

## Review (AGENTS.md §5.3 — dual-agent required)
- [ ] Agent review 1.
- [ ] Agent review 2.
