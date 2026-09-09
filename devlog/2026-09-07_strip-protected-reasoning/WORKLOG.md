# WORKLOG - Strip reasoning from protected-exempt historical messages

- Task ID: `2026-09-07_strip-protected-reasoning`
- Home Repo: `opencode-acp`
- Status: InProgress (review-session gate additions implemented + mutation-verified; awaiting dual-agent review of the new changes, push, human merge of PR #370)
- Updated: 2026-09-09

## 1. Summary

- **What was done**: Implemented a request-time pass `stripProtectedReasoning` that strips `reasoning` parts from protected-exempt (compress/skill) messages in CLOSED historical turns, wired into the message-transform pipeline, with four new config keys (kill-switch + size threshold + provider allowlist + session activation gate) and a full unit-test suite.
- **2026-09-08 review session**: independent review of PR #370 against issue #368 recommended (a) a fail-closed provider allowlist (GPT-family gateways may 400 on incomplete historical thinking), (b) a session activation gate as the cache lever, (c) threshold default 2048→0 (per-message size is cache-noise: invalidation propagates from the first stripped message). Owner approved direct application ("直接修改pr"); all three applied to PR #370's branch.
- **Why**: Reclaim the monotonically-growing, never-compressible reasoning floor (~83.5% of measured residual in #368) without breaking reasoning-replay providers and with bounded cache impact.
- **Behavior / compatibility changes**: Yes — additive request-time transform + additive config keys; no persisted-state/internal-tag changes.
- **Risk level**: Low — mitigated by provider allowlist (fail-closed) + turn-closure gate (current round never touched) + activation gate (small sessions byte-stable) + kill-switch.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `9477f97` | implementation (see Key Files) — PR #370 |
| (pending) | review additions: provider allowlist gate + activation gate + threshold default 0 + 4 config keys registered + tests (mutation-verified) |

### Key Files

- `devlog/2026-09-07_strip-protected-reasoning/REQ.md` — ticket.
- `devlog/2026-09-07_strip-protected-reasoning/DESIGN.md` — design.
- `lib/messages/reasoning-strip.ts` — new `stripProtectedReasoning(messages, protectedTools, threshold): number` pass (3 gates).
- `lib/messages/index.ts` — barrel export.
- `lib/hooks.ts` — wired between `hideConsumedCompressCalls` and `assignMessageRefs`, guarded by kill-switch.
- `lib/messages/reasoning-strip.ts` — (review) `stripProtectedReasoning` gained optional 4th param `options?: {providerID?, allowedProviders?, minMessages?}`; Gate 4 provider allowlist (fail-closed, `"*"`, case-insensitive substring, empty list = strip nothing) + Gate 5 activation (`minMessages > 0 && messages.length < minMessages` → no-op). Omitted options = ungated (pure-function callers unchanged).
- `lib/config.ts` — `compress.stripProtectedReasoning` (bool, default true) + `compress.stripProtectedReasoningThreshold` (number, default **0** after review) + `compress.stripProtectedReasoningProviders` (string[], default `["anthropic","gemini"]`) + `compress.stripProtectedReasoningMinMessages` (number, default **100**): interface + DEFAULT_CONFIG + mergeCompress (providers: explicit array replaces, even `[]`) + excluded from `CompressOverridableConfig` (global-only).
- `lib/config-validation.ts` — registered all four keys in `VALID_CONFIG_KEYS` + `validateConfigTypes` (bool / non-negative finite number / string[] of non-empty strings / non-negative finite number).
- `lib/hooks.ts` — call site passes `threshold ?? 0` + `{providerID: state.modelProviderID, allowedProviders, minMessages}`.
- `dcp.schema.json` — schema properties + defaults for all four keys.
- `tests/reasoning-strip.test.ts` — 18 pass tests (turn-closure, selector, size-threshold, boundary/edge) + 5 config-merge tests + `protectedToolMsg` helper + (review) 14 gate tests: provider match / fail-closed no-match / fail-closed undefined providerID / empty allowlist / `"*"` incl. undefined / case-insensitive substring / omitted-options ungated / activation below-min / at-min (`>=`) / min 0 disables / combined gates / default threshold 0.
- `tests/e2e-message-transform.test.ts` — hook-level kill-switch test (flag=false preserves / flag=true strips) + (review) hook-level provider-gate test (undefined→kept, "openai"→kept, "anthropic"→stripped) + activation-gate test (3-msg fixture, min 100 → kept); `buildConfig` compress base carries permissive strip values (`providers:["*"]`, `minMessages:0`, `threshold:0`) so fixture-sized cases exercise the strip.

## 3. Design & Implementation Notes

- **Entry point / key function**: `stripProtectedReasoning` in `lib/messages/reasoning-strip.ts`, wired in `lib/hooks.ts` after `hideConsumedCompressCalls` before `assignMessageRefs`.
- **Five gates** (request-level 4 & 5 run first; all must hold to strip a message's reasoning):
  0. **provider allowlist** (review): `allowedProviders !== undefined` → empty list strips nothing; else unless `"*"` present, `providerID` must case-insensitively substring-match an entry. **Fail-closed on undefined `providerID`**.
  ½. **activation** (review): `minMessages > 0 && messages.length < minMessages` → no-op (byte-stable prefix for small sessions).
  1. **turn-closure**: message index strictly `< lastUserIndex` (index of `getLastUserMessage`). The current, possibly-open round is never touched.
  2. **selector**: message contains a tool part whose `part.tool` ∈ `config.compress.protectedTools`.
  3. **size**: total reasoning length (sum of `part.text.length` over reasoning parts) `> threshold` (default 0 = strip regardless of size).
- **Action**: `msg.parts = parts.filter(p => p.type !== "reasoning")` — drops reasoning only; tool call + other parts preserved. Returns count removed.
- **Provider gate** (review update): only `anthropic`/`gemini` (default) strip historical reasoning; everyone else — including unknown provider IDs — is untouched (fail-closed). Current round always kept.
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

- New/modified test files: `tests/reasoning-strip.test.ts` (+18 pass tests, +2 merge tests, +14 gate tests), `tests/e2e-message-transform.test.ts` (+1 kill-switch, +2 gate tests).
- Test count: 1112 total, 0 failures (was 1096 before the review additions; 1077 before the PR).
- Key scenarios verified: turn-closure (current round kept), selector (non-protected tool untouched), size threshold (`<= threshold` kept, `== threshold` kept [strict `>`], custom threshold), reasoning-only vs tool+reasoning, idempotency (2nd call removes 0), multi-turn growth cycle (closed turns stripped, current kept), summing across multiple reasoning parts, no-user-msg no-op, empty-protectedTools no-op, **synthetic-user boundary** (anchors on last genuine user msg), **first-user no-op** (`lastUserIndex<=0`), config merge (default / kill-switch / custom threshold), **hook-level kill-switch** (e2e: flag=false preserves / flag=true strips).

### Mutation verification (§5.7.3, review additions)

- Provider gate: replacing `if (allowedProviders !== undefined)` with `if (false && ...)` → 4 tests fail (fail-closed no-match, fail-closed undefined, empty allowlist, combined gates). Restored; suite green.
- Activation gate: replacing the `minMessages` condition with `false && ...` → 2 tests fail (unit "below minMessages strips nothing"; e2e "below minMessages the handler preserves reasoning"). Restored; full suite 1112/1112 green.

### Results

- **PASS/FAIL**: PASS — typecheck clean, build clean, 1112/1112 tests pass.
- **Key logs/data**: `tests/reasoning-strip.test.ts` 39/39 in-file; `tests/e2e-message-transform.test.ts` 17/17 in-file.

### Dual-Agent Review (2026-09-08, both via `task`+`general`)

Both reviewers returned REQUEST-CHANGES; core logic / tests / pipeline integration confirmed clean. All findings addressed:
- **Code**: (MAJOR-2) registered new keys in `config-validation.ts` `VALID_CONFIG_KEYS` + `validateConfigTypes` (was a real "Unknown keys" TUI-toast bug); (MAJOR-3) excluded keys from `CompressOverridableConfig` (dead per-provider override); (MINOR-3) `Array.isArray(message.parts)` guard; (MAJOR-1/MINOR-1) REQ/DESIGN updated for the owner no-gate decision.
- **Test**: (F1 MAJOR) added the hook-level kill-switch e2e test — **mutation-verified** (replacing the guard with `if(true)` makes it fail); (F3) synthetic-user boundary test; (F4) first-user no-op test; (F6) test-name precision fix.
- **Skipped (with rationale)**: provider gate (owner declined — "provider 先不管 有问题再说"); F2 idempotency test (idempotent by construction); F5 fixture `time` field (NIT, consistent with existing style).

### Dual-Agent Review — Round 2 (2026-09-08/09, second pass on the review-session additions)

After applying the provider/activation gates, a second dual-agent review (source + test focus) returned **APPROVE + APPROVE** (no MAJOR). Findings and dispositions:
- **R1-MINOR-2 (fixed)**: hooks.ts passed `state.modelProviderID` — undefined on the first request of a fresh session. Now `requestModel?.providerID ?? state.modelProviderID` (`requestModel` hoisted above the if/else at ~:187 from the last user message's `info.model`), preferring this request's provider metadata.
- **R1-MINOR-3 (fixed)**: allowlist entries now `.trim()`-ed at match time (both the substring match and the `"*"` check) — padded `" anthropic "` / `" * "` configs work. Pinned by unit test.
- **R1-MINOR-1/4/5/6**: doc comment clarified (undefined = gate disabled vs [] = strip nothing); duplicated default literals kept (now pinned by tests, see below); `as unknown[]` cast kept (narrow, local); internal `dcp` naming unchanged. No action needed.
- **R2-F1 (fixed)**: added 9 `tests/config-validation.test.ts` cases for the two new keys (valid/empty-list OK, wrong type, non-string entries, empty-string entries, negative, **fractional rejected** — validation tightened from `Number.isFinite` to `Number.isInteger`, schema type → `integer`).
- **R2-F2 (fixed)**: new e2e `gate fallbacks` test — config with undefined gate fields must behave as DEFAULT_CONFIG (openai kept; short anthropic session kept; 101-message anthropic session strips). **Mutation-verified**: removing the hooks.ts `??` fallbacks makes it fail (reviewer 2's Mutation C previously survived with 0 failures).
- **R2-F3 (follow-up, pre-existing)**: e2e `buildConfig` omits 8 required `CompressConfig` fields + has a phantom `mode` — compiles only because `tsconfig.json` excludes tests from typecheck. Candidate follow-up: add `tests/**/*` to tsconfig include + complete buildConfig (may surface pre-existing errors — separate PR).
- **R2-NIT 4/6/7 (fixed)**: tight boundary test (`minMessages: 4` vs 3-message fixture → no-op) + presence assertions (`!parts.some(reasoning)` after strip, `parts.some(reasoning)` when kept) + integer validation (above).
- **R2-NIT 5 (moot)**: provider-gate e2e rewritten to drive provider via last-user-message `info.model` metadata (4 sub-cases incl. metadata-vs-cached-state precedence and the `?? state` fallback), removing the hidden dependency reviewer flagged.
- **Extra (found while rewriting e2e)**: `stripStaleMetadata` (`lib/messages/reasoning-strip.ts:15`) dereferences `lastUserMessage.info.model.modelID` without optional chaining — crashes if a user message lacks `info.model`. Pre-existing, out of scope; noted to owner.
- **Verification**: 1124/1124 tests pass (was 1112 at PR open; +1 padded-entries, +1 tight boundary, +9 config-validation, +1 fallback e2e), typecheck + build clean. All 4 mutations re-verified: provider gate → 5 fails; activation gate → 2 fails; hook options dropped → 2 e2e fails; hook fallbacks dropped → 1 e2e fail.

## 5. Risk Assessment & Rollback

- **Risk points**: provider reasoning-replay semantics (mitigated: allowlist fail-closed + current round never touched); one-time cache rebuild on enablement (bounded, not continuous; activation gate keeps small sessions untouched); correctness of the protected-tool selector (matches `config.compress.protectedTools`).
- **Rollback method**:
  - Config: set `compress.stripProtectedReasoning: false` (immediate no-op).
   - Revert commit(s): `9477f97` (PR #370).
- **Compatibility notes**: additive config keys only; no persisted-state or internal-tag changes.

## 6. Lessons Learned

- Prettier version drift: `npm ci` installs Prettier 3.9.5 (lockfile) vs the ~3.8.x the repo was formatted with; `format:check` flags 425 pre-existing files. CI does NOT gate on format. New code matches the de-facto committed convention (single-line part literals, 4-space, no semi); pre-existing lines left untouched to avoid diff noise.

## 7. Follow-ups (separate issues, source marker `来源: #368 ...`)

- [x] #368 secondary finding **A** → filed as **#371** (display/`acp_status` estimator excludes reasoning; `lib/messages/inject/utils.ts:586`).
- [x] #368 secondary finding **B** → filed as **#372** (orphaned `byMessageId` entries stay visible; `lib/messages/prune.ts:60-66`).
- [x] #368 secondary finding **C** → filed as **#373** (`rewriteCompressInput` full-consumption leak; `lib/compress/hide-consumed.ts:42`).
- [x] Main #368 filed to `ranxianglei/billion-context` (**#651**) and `ranxianglei/billion-context-pi` (**#336**) (owner request).
- [x] PR opened: **#370** (awaiting human merge).
- [x] 2026-09-08 review session applied to PR #370: provider allowlist + activation gate + threshold 0 (owner: "直接修改pr").
- [x] 2026-09-09 config docs: added the 4 `stripProtectedReasoning` keys to `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` (reference sections) and `README.md`, `README.zh-CN.md` (example config blocks), both languages (user: "配置文件文档没改 中英文的").
