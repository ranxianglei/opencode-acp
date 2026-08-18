# WORKLOG - Stabilize system prompt token estimate (#255)

## Changes

1. `lib/ui/utils.ts` — `cacheSystemPromptTokens`: added write-if-undefined
   guard. Once `state.systemPromptTokens` holds a stable positive value, later
   transforms never overwrite it — after compression/compaction the first
   visible assistant's input includes large history, which would inflate the
   estimate. `undefined` stays `undefined` when no reliable assistant token data
   is present.

2. `lib/messages/inject/utils.ts` — `estimateContextComposition`: `systemTokens`
   now prefers `state?.systemPromptTokens` (when positive); falls back to
   `estimateSystemPromptTokens(messages)` when undefined — old behavior
   preserved.

3. `lib/compress/status.ts` — `collectVisibleMessages`: `systemTokens` now
   prefers `ctx.state.systemPromptTokens` (when positive); falls back to
   `estimateSystemPromptTokens(rawMessages)` when undefined.

4. Tests:
    - `tests/inject-utils-pure.test.ts` — 5 new tests: cached-value preference,
      undefined-cache fallback, cache-overwrite protection, initial write,
      keep-undefined-when-no-data.
    - `tests/acp-status.test.ts` — 1 new test: overview breakdown uses cached
      value instead of re-estimating from degraded visible messages.

## Test Results (pre-fix verification)

The 3 bug-targeting tests were confirmed FAILING on unmodified master before
the fix (e.g. `199996 !== 10000`), proving they capture the #255 regression.

- 44 tests in inject-utils-pure.test.ts (2 new failing pre-fix)
- 24 tests in acp-status.test.ts (1 new failing pre-fix)

## Test Results (post-fix)

- typecheck: pass (`tsc --noEmit`, exit 0)
- build: pass (tsup success)
- test: 1009 pass / 0 fail (full suite, `npm run test`)

## Scope Notes

Per human review of the investigation phase, this PR is intentionally minimal:

- No persistence changes (`PersistedSessionState` / save / load untouched).
- No model/provider identity invalidation.
- No `/acp context` changes.
- `estimateSystemPromptTokens()` public semantics unchanged.
- `package.json` version unchanged.
