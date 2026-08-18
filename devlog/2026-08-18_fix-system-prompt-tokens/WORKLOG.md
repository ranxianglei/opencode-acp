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

4. Tests (unit):
    - `tests/inject-utils-pure.test.ts` — 5 new tests: cached-value preference,
      undefined-cache fallback, cache-overwrite protection, initial write,
      keep-undefined-when-no-data.
    - `tests/acp-status.test.ts` — 1 new test: overview breakdown uses cached
      value instead of re-estimating from degraded visible messages.
    - `tests/inject.test.ts` — 1 new §5.7-compliant multi-turn growth-cycle test
      (4 turns: baseline → growth → nudge → compress → new baseline → growth →
      nudge) with `preserveRecentMessages = 20` (production default),
      side-effect assertions (`shouldInjectThisTurn` + `lastPerMessageNudgeTokens`
      after every turn), and #255 assertions (cached system value survives
      degraded post-compression arrays).

5. E2E infrastructure (`scripts/e2e/`, test-only — not production):
    - `fake-llm-server.ts` — observation now records `nudgeSystemTokens` parsed
      from the nudge breakdown text (`Breakdown: N system`).
    - `verify.ts` — new `nudgeSystemTokensStable` assertion: all nudge
      observations must report the same system estimate (requires ≥2 nudge
      observations).
    - `scenarios/10-autonomous-nudge-refire.json` — added
      `nudgeSystemTokensStable: true` (extended existing scenario; scenario 10
      already exercises multi-turn nudge→compress→growth→re-nudge with ≥2 nudge
      observations).

## Test Results (pre-fix verification)

The bug-targeting tests were confirmed FAILING on unmodified production code
before the fix:

- `estimateContextComposition: prefers cached...` — FAIL (199996 !== 10000)
- `cacheSystemPromptTokens: does not overwrite...` — FAIL (199996 !== 10000)
- `acp_status: overview prefers cached...` — FAIL
- §5.7 multi-turn cycle test — FAIL under reverted production fix
- E2E scenario 10 with `nudgeSystemTokensStable` — FAIL under reverted fix
  (observed system values `[18200, 18700]` diverged after compression)

All confirmed via `git show 09bf2b8 -- lib/ | git apply -R` + test run + `git
apply` restore. No temporary reverts committed.

## Test Results (post-fix)

- typecheck: pass (`tsc --noEmit`, exit 0)
- build: pass (tsup success)
- test: 1009 + 1 new = 1010 pass / 0 fail (full suite, `npm run test`)
- Docker E2E: all 12 scenarios pass (`SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh`),
  including scenario 10 with the new `nudgeSystemTokensStable` assertion
- Live OpenCode smoke test: plugin loads, ACP state file written, no
  ACP-related errors (the only observed errors were opencode→model-gateway TLS
  certificate failures, unrelated to ACP)

## Scope Notes

Per human review of the investigation phase, this PR is intentionally minimal:

- No persistence changes (`PersistedSessionState` / save / load untouched).
- No model/provider identity invalidation.
- No `/acp context` changes.
- `estimateSystemPromptTokens()` public semantics unchanged.
- `package.json` version unchanged.
- Production changes are 3 small source edits; test/E2E additions are scoped to
  verification of the fix.
