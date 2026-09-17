# 2026-09-17_v2-compaction-phantom-system — V2 compaction usage becomes phantom system overhead

- **Date**: 2026-09-17
- **Owner**: ranxianglei
- **Issue**: https://github.com/ranxianglei/opencode-acp/issues/421
- **Branch**: `2026-09-17_v2-compaction-phantom-system`
- **Scope**: dual-runtime fork (`drexb-ops/opencode-acp@1fe36e0`), official OpenCode v2.0.3

## 背景 (Background)

After a native OpenCode v2 compaction, the first provider request reports the
compaction request's own `usage.input` (~653K in the repro) as its input token
count. Because ACP calibrates `systemPromptTokens` as
"first assistant input − first user text" and never invalidates that cache, the
compaction request's usage becomes a permanent phantom system overhead:

```
cacheSystemPromptTokens → 653137 - 1 = 653136 stored forever
budget = 400000 - 653136 - 32768 = -285904   (negative hard-guard budget)
```

Replaying the settled real context shows only ~653K raw but the live conversation
is far smaller; live logs show negative budgets while recent provider usage is
normal-sized. The same poisoned value also flows into `estimateWireTokens`
fallback, `truncate-tools` overhead, nudge composition display, and `/acp status`.

Root cause chain (verified in code):

1. `lib/v2/projection/normalize.ts:137-141` — compaction source normalizes to an
   assistant with `summary: true`.
2. `lib/v2/projection/shared.ts:204-238` — `makeAssistantInfo` copies the
   compaction request's `tokens` verbatim onto that assistant.
3. `lib/ui/utils.ts:56-100` — `cacheSystemPromptTokens` treats the FIRST
   assistant with input > 0 as the calibration anchor: no exclusion of
   `info.summary === true`, no `state.lastCompaction` age guard, no model-change
   guard. FIX #255's early-return makes the value sticky forever once written.
4. `lib/messages/transform.ts:217-229` — hard guard subtracts the phantom value
   from the model limit → negative budget.
5. Consumers inherit the inflated count: `enforce-budget.ts:99`,
   `truncate-tools.ts:67`, `inject/utils.ts:731`, `compress/status.ts:199`.

Related issues screened: #395 (pre-fork baseline variant, closed), #418 (opaque
source restoration — explicitly carved this calibration defect OUT of its scope),
#419 (separate concern). Not a duplicate.

## 目标 (Goal)

1. Compaction-request usage must never poison the system-overhead estimate:
   exclude `summary === true` assistants and assistants created before
   `state.lastCompaction` from the calibration anchor.
2. Use coherent wire accounting when available: V2 receives the actual outgoing
   `event.system` parts; feed their measured token count into calibration as a
   floor, so the stored value reflects the current wire (system + tools)
   overhead rather than only the rendered prompt.
3. Invalidate the cached estimate on native compaction (`resetOnCompaction`) and
   on mid-session model switch, so post-event recalibration uses post-event data.
4. Distinguish heuristic estimates from actual provider/measured values in
   `/acp status` output.
5. Preserve V1 behavior and all #255 guarantees (stable positive cache not
   overwritten by degraded estimates).

## 范围 (Scope)

In scope:

- `lib/token-utils.ts` — new `calibrateSystemOverhead(state, messages)` with
  guards + prefix-sum subtraction; `estimateSystemPromptTokens` delegates to it.
- `lib/ui/utils.ts` — `cacheSystemPromptTokens(state, messages, measured?)`:
  calibrated heuristic vs measured floor; provenance recorded.
- `lib/state/types.ts`, `lib/state/state.ts`, `lib/state/utils.ts`,
  `lib/state/transaction.ts` — new `systemPromptTokensSource` field ("heuristic"
  | "measured"), init/reset/clone/commit wiring, invalidation in
  `resetOnCompaction`.
- `lib/messages/transform.ts` — `measuredSystemTokens` option, model-switch
  invalidation, pass-through.
- `lib/hooks.ts` — thread optional param through
  `prepareMessageTransformTransaction`.
- `lib/v2/context.ts` — measure `event.system` (+ own ACP system part) and pass
  to prepare.
- `lib/compress/status.ts` — label the system segment `(estimated)` /
  `(measured)` in `/acp status` overview.
- New regression test file `tests/v2-compaction-system-overhead.test.ts`.

Out of scope:

- Changing how V2 projection normalizes compaction sources (#418 territory).
- Changing `getCurrentTokenUsage` semantics (already has the compaction guard).
- Any `version` bump or changelog entry (release-branch territory).
- V1 runtime changes beyond the shared transform path.

## 验收标准 (Acceptance criteria)

From issue #421:

1. First request after compaction AND after reload, before any post-compaction
   assistant has usage: no phantom overhead; usable budget nonnegative.
2. Current-wire accounting used where available (V2 measured `event.system`).
3. No unnecessary tool clearing triggered by the phantom budget.
4. Heuristic estimates vs actual provider/measured values distinguishable in
   status output.
5. Existing suite stays green (all 591+ tests incl. #255 tests); repro test
   verified to FAIL without the fix.

## 约束 (Constraints)

- No new dependencies. No `as any` / `@ts-ignore` in lib/.
- Internal `dcp` naming untouched; persisted state format backward compatible
  (new field optional/absent-tolerant).
- Dual-agent review of code and tests required before merge.
- PR references issue #421; agent never merges.
