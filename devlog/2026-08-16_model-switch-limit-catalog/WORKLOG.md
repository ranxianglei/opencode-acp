# WORKLOG - Fix wrong context-level math after model switch (issue #312)

- Task ID: `2026-08-16_model-switch-limit-catalog`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-16

## 1. Summary

- **What was done**: `SessionStateRegistry` now keeps a `${providerID}/${modelID}` → context-limit catalog. The system hook records every observed model's limit into it; the messages hook reconciles `state.modelContextLimit` from the catalog (keyed by the model on the request's user message) before any threshold math; plugin init seeds the catalog from `GET /config/providers`.
- **Why**: Within one LLM request the host fires `messages.transform` BEFORE `system.transform`, and only the latter wrote `modelContextLimit` — so the first request after a model switch computed every percentage against the previous model's window (issue #312: 50% emergency fired at 26% after 200K → 1M).
- **Behavior / compatibility changes**: Yes — threshold math now uses the new model's limit on the first request after a switch. Unknown models keep the previous fallback (stale limit for one request). No persisted-state, config-schema, or exported-API changes.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `lib/state/state.ts` — `SessionStateRegistry.modelLimits: Map<string, number>` + `recordModelLimit(providerId, modelId, limit)` + `resolveModelLimit(providerId, modelId)` + `hydrateModelLimitsFromClient(client): Promise<number>` (best-effort, never throws).
- `lib/hooks.ts` —
  - `createSystemPromptHandler`: records `input.model.limit.context` into the catalog keyed by `providerID`/`id`, placed BEFORE the `registry.get` guard so it works even when the session state has not been created; system-hook input type widened to include optional `model.id` / `model.providerID`.
  - `createChatMessageTransformHandler`: after `registry.getOrCreate`, reconciles `state.modelContextLimit` from `registry.resolveModelLimit` for the model on `lastUserMessage.info.model` (undefined-safe; unknown model keeps the previous value).
- `index.ts` — fire-and-forget `registry.hydrateModelLimitsFromClient(ctx.client).catch(() => {})` at init, so the FIRST switch in an instance resolves even for models never used before.
- `tests/registry-stub.ts` — `createTestRegistry` now exposes the same `recordModelLimit`/`resolveModelLimit` surface backed by a local `Map`.
- `tests/model-switch-limits.test.ts` — new: 7 regression tests.

## 3. Design & Implementation Notes

- **Why a catalog instead of just persisting the last limit**: the state carries ONE `modelContextLimit`; a switch needs the NEW model's limit before the system hook runs. A per-model map recorded from every system.transform call (plus an init-time seed from the host's provider catalog) resolves the lookup synchronously in the messages hook with no extra round-trip on the hot path.
- **Unknown-model fallback**: if the catalog misses (e.g. hydration failed and the model was never used in this instance), reconciliation is a no-op — exactly the pre-fix behavior, and the system hook still corrects the state later in the same request. This keeps the fix purely additive.
- **`hydrateModelLimitsFromClient` shape**: `client.config.providers()` returns `{ data: { providers: [{ id, models: { [modelId]: { limit: { context } } } }] } }` (SDK `ConfigProvidersResponses` / host `ConfigProvidersResult`). All field access is `unknown`-guarded; any failure returns 0.
- **Hot-path cost**: one `Map.get` per messages.transform. The hydration is one HTTP call per plugin init.

## 4. Testing & Verification

### Build & Test Commands

```sh
npx tsc --noEmit                                   # clean
node --import tsx --test tests/model-switch-limits.test.ts   # 7/7 pass
node --import tsx --test tests/*.test.ts           # 988 pass, 0 fail
```

### Test Scenarios (tests/model-switch-limits.test.ts)

1. **200K → 1M switch, 260K tokens, `"50%"` emergency**: reconciled limit = 1M; no "Context limit reached" nudge; no nudge baseline recorded. (The issue #312 scenario.)
2. **Unknown model in catalog**: limit stays 200K; emergency fires at 260K — documents the pre-fix fallback path.
3. **1M → 200K switch, 150K tokens**: reconciled limit = 200K; emergency DOES fire (75% ≥ 50%) — stale 1M limit would have missed it.
4. **system.transform records into catalog even when session state is absent** (`sessionID: "never-seen"`).
5. **Catalog rejects invalid entries** (undefined ids, limit ≤ 0) and unknown lookups.
6. **`hydrateModelLimitsFromClient` seeds from a mocked `/config/providers` payload** (2 valid + 1 broken model).
7. **`hydrateModelLimitsFromClient` tolerates missing and throwing clients** (returns 0).

## 5. Follow-ups

- None blocking. Potential (not done, out of scope): debounced re-hydration if
  providers change at runtime.
