# WORKLOG - Strip reasoning from protected-exempt historical messages

- Task ID: `2026-09-07_strip-protected-reasoning`
- Home Repo: `opencode-acp`
- Status: InProgress (implementation + dual-agent review fixes complete; awaiting commit + PR)
- Updated: 2026-09-08 23:05

## 1. Summary

- **What was done**: Implemented a request-time pass `stripProtectedReasoning` that strips `reasoning` parts from protected-exempt (compress/skill) messages in CLOSED historical turns, wired into the message-transform pipeline, with two new config keys (kill-switch + size threshold) and a full unit-test suite.
- **Why**: Reclaim the monotonically-growing, never-compressible reasoning floor (~83.5% of measured residual in #368) without breaking reasoning-replay providers and with bounded cache impact.
- **Behavior / compatibility changes**: Yes — additive request-time transform + additive config keys; no persisted-state/internal-tag changes.
- **Risk level**: Low-Medium — mitigated by turn-closure gate (current round never touched) + size threshold (small reasoning untouched) + kill-switch. Provider gate intentionally omitted per owner decision ("provider 先不管 有问题再说" — handle reactively).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| _pending_ | implementation (see Key Files) |

### Key Files

- `devlog/2026-09-07_strip-protected-reasoning/REQ.md` — ticket.
- `devlog/2026-09-07_strip-protected-reasoning/DESIGN.md` — design.
- `lib/messages/reasoning-strip.ts` — new `stripProtectedReasoning(messages, protectedTools, threshold): number` pass (3 gates).
- `lib/messages/index.ts` — barrel export.
- `lib/hooks.ts` — wired between `hideConsumedCompressCalls` and `assignMessageRefs`, guarded by kill-switch.
- `lib/config.ts` — `compress.stripProtectedReasoning` (bool, default true) + `compress.stripProtectedReasoningThreshold` (number, default 2048): interface + DEFAULT_CONFIG + mergeCompress + excluded from `CompressOverridableConfig` (global-only, not per-provider overridable).
- `lib/config-validation.ts` — registered both keys in `VALID_CONFIG_KEYS` + `validateConfigTypes` (bool / non-negative finite number).
- `dcp.schema.json` — schema properties + default.
- `tests/reasoning-strip.test.ts` — 18 pass tests (turn-closure, selector, size-threshold, boundary/edge) + 3 config-merge tests + `protectedToolMsg` helper.
- `tests/e2e-message-transform.test.ts` — hook-level kill-switch test (flag=false preserves / flag=true strips); `buildConfig`/`setupPipeline` extended (backward-compatible) to accept config overrides.

## 3. Design & Implementation Notes

- **Entry point / key function**: `stripProtectedReasoning` in `lib/messages/reasoning-strip.ts`, wired in `lib/hooks.ts` after `hideConsumedCompressCalls` before `assignMessageRefs`.
- **Three gates** (all must hold to strip a message's reasoning):
  1. **turn-closure**: message index strictly `< lastUserIndex` (index of `getLastUserMessage`). The current, possibly-open round is never touched.
  2. **selector**: message contains a tool part whose `part.tool` ∈ `config.compress.protectedTools`.
  3. **size**: total reasoning length (sum of `part.text.length` over reasoning parts) `> threshold` (default 2048).
- **Action**: `msg.parts = parts.filter(p => p.type !== "reasoning")` — drops reasoning only; tool call + other parts preserved. Returns count removed.
- **No provider gate** (per owner): closed-turn reasoning is stripped for all providers; current round always kept.
- **Deterministic / cache-stable**: within a turn the output is byte-stable; the boundary shifts only when a new user turn starts (which invalidates the prefix cache anyway).

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build
npm run typecheck
node --import tsx --test tests/reasoning-strip.test.ts
npm test
```

### Test Coverage

- New/modified test files: `tests/reasoning-strip.test.ts` (+18), `tests/e2e-message-transform.test.ts` (+1 kill-switch).
- Test count: 1096 total, 0 failures (was 1077 before this change).
- Key scenarios verified: turn-closure (current round kept), selector (non-protected tool untouched), size threshold (`<= threshold` kept, `== threshold` kept [strict `>`], custom threshold), reasoning-only vs tool+reasoning, idempotency (2nd call removes 0), multi-turn growth cycle (closed turns stripped, current kept), summing across multiple reasoning parts, no-user-msg no-op, empty-protectedTools no-op, **synthetic-user boundary** (anchors on last genuine user msg), **first-user no-op** (`lastUserIndex<=0`), config merge (default / kill-switch / custom threshold), **hook-level kill-switch** (e2e: flag=false preserves / flag=true strips).

### Results

- **PASS/FAIL**: PASS — typecheck clean, build clean, 1096/1096 tests pass.
- **Key logs/data**: `tests/reasoning-strip.test.ts` 25/25 in-file (7 pre-existing `stripStaleMetadata` + 18 new).

### Dual-Agent Review (2026-09-08, both via `task`+`general`)

Both reviewers returned REQUEST-CHANGES; core logic / tests / pipeline integration confirmed clean. All findings addressed:
- **Code**: (MAJOR-2) registered new keys in `config-validation.ts` `VALID_CONFIG_KEYS` + `validateConfigTypes` (was a real "Unknown keys" TUI-toast bug); (MAJOR-3) excluded keys from `CompressOverridableConfig` (dead per-provider override); (MINOR-3) `Array.isArray(message.parts)` guard; (MAJOR-1/MINOR-1) REQ/DESIGN updated for the owner no-gate decision.
- **Test**: (F1 MAJOR) added the hook-level kill-switch e2e test — **mutation-verified** (replacing the guard with `if(true)` makes it fail); (F3) synthetic-user boundary test; (F4) first-user no-op test; (F6) test-name precision fix.
- **Skipped (with rationale)**: provider gate (owner declined — "provider 先不管 有问题再说"); F2 idempotency test (idempotent by construction); F5 fixture `time` field (NIT, consistent with existing style).

## 5. Risk Assessment & Rollback

- **Risk points**: provider reasoning-replay semantics (mitigated: current round never touched; historical closed-turn reasoning is the standard-strippable case); one-time cache rebuild on enablement (bounded, not continuous); correctness of the protected-tool selector (matches `config.compress.protectedTools`).
- **Rollback method**:
  - Config: set `compress.stripProtectedReasoning: false` (immediate no-op).
  - Revert commit(s): _pending sha_.
- **Compatibility notes**: additive config keys only; no persisted-state or internal-tag changes.

## 6. Lessons Learned

- Prettier version drift: `npm ci` installs Prettier 3.9.5 (lockfile) vs the ~3.8.x the repo was formatted with; `format:check` flags 425 pre-existing files. CI does NOT gate on format. New code matches the de-facto committed convention (single-line part literals, 4-space, no semi); pre-existing lines left untouched to avoid diff noise.

## 7. Follow-ups (separate issues, source marker `来源: #368 ...`)

- [ ] #368 secondary finding **A** — display/`acp_status` estimator excludes reasoning (`lib/messages/inject/utils.ts:586` `estimateContextComposition` counts only text+tool; real usage includes reasoning per `lib/token-utils.ts:19,44`).
- [ ] #368 secondary finding **B** — orphaned `byMessageId` entries with emptied `activeBlockIds` stay visible forever (`lib/messages/prune.ts:60-66`).
- [ ] #368 secondary finding **C** — `rewriteCompressInput` full-consumption leak (`lib/compress/hide-consumed.ts:42` `kept.length === 0 → return null`).
- [ ] File the main #368 issue to `ranxianglei/billion-context` and `ranxianglei/billion-context-pi` (owner request).
