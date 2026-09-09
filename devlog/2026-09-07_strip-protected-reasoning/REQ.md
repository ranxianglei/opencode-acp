# REQ - Strip reasoning from protected-exempt historical messages

- Task ID: `2026-09-07_strip-protected-reasoning`
- Home Repo: `opencode-acp`
- Created: 2026-09-07
- Status: InProgress (**updated 2026-09-08 per review**: provider gate + activation gate added, threshold default 2048→0 — supersedes the 2026-09-07 "no provider gate" decision; see §3 + DESIGN.md §8)
- Priority: P1
- Owner: ework-daemon (agent) / ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/368

## 1. Background & Problem Statement

- **Context**: On long sessions, ACP force-protects `compress` and `skill` messages. Protection is **message-granular** (`lib/compress/protected-content.ts:202` `removedMessageIds.add(messageId)`), so the *whole* assistant message — including its `reasoning` parts — is excluded from every compression selection.
- **Current behavior (symptom)**: Those excluded messages never enter the compression index, so `prune` (`lib/messages/prune.ts:60-66`) re-sends them **every turn**, reasoning riding along. Each compress/skill round therefore adds one permanently-exempt message carrying ~9 KB of reasoning (measured mean 9,418 B, max 28,067 B/msg in the audited session). The floor grows monotonically with every compression — a feedback loop. In the forensically-audited session (#368), `reasoning` parts were **~83.5% of the never-covered residual** (446 KB of 563 KB rode on `compress`-part messages).
- **Expected behavior**: Reclaim that reasoning floor at request time **without** losing user-visible or compression-critical data, **without** breaking providers that require reasoning replay, and with **bounded** prefix-cache impact.
- **Impact**: A monotonically-growing incompressible base makes context fill faster → triggers more compression → raises the floor further.

## 2. Reproduction (if applicable)

- **Environment**: opencode-acp 1.14.27 (branch base = `origin/master` @ v1.14.27, matching the reporter's audit baseline).
- **Minimal reproduction steps**:
  1) Long session with repeated `compress` calls (or `skill` usage) on a high-thinking model.
  2) Read-only audit over `opencode.db` (message/part) joined against the ACP registry JSON (`prune.messages.byMessageId`, `blocksById[*].effectiveMessageIds/compressCallId/active`): count bytes of parts in messages never covered by any block, grouped by protected-tool co-occurrence of the parent message.
- **Relevant configuration**: default `compress.protectedTools = ["skill","compress"]`; `compress` additionally in `FORCE_COMPRESS_PROTECTED` (`lib/config.ts:167`).

> The exact session numbers (83%, ~9 KB/round) come from the reporter's audit and are not independently reproducible here; the **mechanism** producing the floor is fully code-verified.

## 3. Constraints & Non-Goals

- **Constraints**:
  - **Request-time transform only.** ACP is a plugin with the `experimental.chat.messages.transform` hook; it can only rewrite the per-request message array. It **cannot** modify opencode's stored messages, and (per reporter) must avoid persistent/DB writes.
  - **Provider safety (review update 2026-09-08: allowlist gate, fail-closed).** Some upstreams may require reasoning to be replayed complete (operator: **GPT/OpenAI** requires complete thinking). The initial design shipped without a provider gate (owner 2026-09-07: "provider 先不管 有问题再说"); the independent review of PR #370 recommended a **provider allowlist** (fail-closed: unknown/unmatched/undefined provider → strip nothing) and the owner approved applying the review to the PR directly ("直接修改pr", 2026-09-08). Defaults: `["anthropic","gemini"]`, `"*"` = all providers, case-insensitive substring match. The **turn-closure gate** remains the primary safety mechanism (the active round is always preserved); kill-switch `stripProtectedReasoning: false` remains the self-service mitigation.
  - **Turn safety.** Never strip the **current open round's** reasoning (Anthropic thinking-signature / Gemini `thought_signature` replay on the active tool round).
  - **Cache stability.** The sent prefix must be byte-identical across consecutive requests *within a turn* so prompt caching keeps hitting; invalidation must be bounded (turn-boundary shifts + one-time enablement rebuild only).
  - **Surgical.** Only drop `reasoning` parts; never touch user-visible `text`; message identity/order unchanged (no effect on `mNNNNN` ref assignment).
- **Non-Goals** (explicitly out of scope):
  - Part-granular protection rework (protect the tool *part* but let the *reasoning part* compress normally) — larger, changes selection semantics; reporter judged it non-minimal; **separate effort**.
  - The three secondary findings from #368 (A: display estimator excludes reasoning; B: orphaned `byMessageId` entries; C: `rewriteCompressInput` full-consumption leak) — **filed as separate issues**.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
   - [ ] `reasoning` parts are removed from assistant messages only when **all five gates** hold: (1) **provider allowlist** (`stripProtectedReasoningProviders`, default `["anthropic","gemini"]`; fail-closed on unknown/undefined provider; `"*"` = all; case-insensitive substring), (2) **session activation** (`stripProtectedReasoningMinMessages`, default 100; `0` = always; strips only when `messages.length >= minMessages`), (3) message is **before** the last genuine user message, (4) contains a **protected tool part** (`compress`/`skill`), (5) total `reasoning` length **exceeds the threshold** (default 0 = strip regardless of size).
  - [ ] Provider gate is **fail-closed**: undefined/unmatched `modelProviderID` → no stripping (verified at hook level).
  - [ ] Below `minMessages` the pass is a byte-stable no-op (small-session prefix cache untouched).
  - [ ] `reasoning` is **never** removed from any assistant message at/after the last genuine user message (the current round).
  - [ ] Messages carrying user-visible `text` are not modified (only `reasoning` parts dropped).
   - [ ] Kill-switch `stripProtectedReasoning: false` disables the pass entirely (no-op) — verified at the **hook level** (full transform handler), not just the pure function.
  - [ ] No DB/state writes; request-time only (idempotent, no persisted mutation).
  - [ ] Fail-safe: if no genuine user message is found, the pass strips nothing.
- **Performance / Stability**:
  - [ ] For a fixed message array within a turn, the transformed prefix is byte-identical across repeated calls (cache-stable).
- **Regression**:
  - [ ] New/modified test cases added and passing, per §5.7: multi-turn (≥2 `inject`-style calls sharing state), side-effect assertions, `preserveRecentMessages > 0`, full growth cycle; plus Docker E2E per §5.7.2.
  - [ ] `npm run build`, `npm run typecheck`, full `npm run test` all green.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/messages/reasoning-strip.ts` — add the new pass function (distinct name from existing `stripStaleMetadata`).
  - `lib/hooks.ts` — wire the pass **after** `hideConsumedCompressCalls` (`:258`), **before** `assignMessageRefs` (`:259`).
   - `lib/config.ts` + `dcp.schema.json` + `lib/config-validation.ts` — config keys: `compress.stripProtectedReasoning` (bool, kill-switch, default `true`), `compress.stripProtectedReasoningThreshold` (number, default `0` chars — review: cache invalidation propagates from the first divergent message, so per-message size gating saves nothing; the activation gate is the cache lever), `compress.stripProtectedReasoningProviders` (string[], default `["anthropic","gemini"]`, `"*"` = all, case-insensitive substring; explicit `[]` = strip for no provider), `compress.stripProtectedReasoningMinMessages` (integer ≥ 0, default `100`; `0` = always active; fractional rejected by validation). All registered in `VALID_CONFIG_KEYS` + `validateConfigTypes`; threshold/providers/minMessages excluded from `CompressOverridableConfig` (global-only, not per-provider overridable).
   - `tests/reasoning-strip.test.ts` — unit tests for the pass; `tests/e2e-message-transform.test.ts` — hook-level kill-switch test.
- **Risks**:
   - Provider semantics (no provider gate per owner decision; mitigated by the turn-closure gate + global kill-switch; residual cross-turn thinking-signature validation risk handled reactively).
   - Cache invalidation (mitigated: turn-stable prefix; bounded to boundary shifts + one-time enablement rebuild).
- **Rollback strategy**: config kill-switch (`stripProtectedReasoning: false`) for immediate disable; revert the commit for full rollback.
- **RESOLVED (owner decision 2026-09-07; updated 2026-09-08 review session)** — see DESIGN.md §8:
   - **Provider gate: ADDED** (review update). Initial decision was no gate ("provider 先不管 有问题再说"); the independent PR #370 review recommended a fail-closed allowlist and the owner approved direct application to the PR ("直接修改pr"). Default `["anthropic","gemini"]`.
   - Ships **default-on** with the global kill-switch `stripProtectedReasoning: false`.
   - **Threshold default 2048→0** (review: per-message size is noise for prefix-cache purposes — invalidation propagates from the first divergent message; the activation gate is the cache lever).
   - **Activation gate ADDED** (`stripProtectedReasoningMinMessages: 100`; absorbs the issue-thread "turn-count-gated handling of ancient content" idea — same intent, scoped to the strip pass instead of compression itself).
