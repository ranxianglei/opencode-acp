# DESIGN - Strip reasoning from protected-exempt historical messages

- Task ID: `2026-09-07_strip-protected-reasoning`
- Home Repo: `opencode-acp`
- Created: 2026-09-07
- Status: Final (updated 2026-09-08 per review: **provider allowlist gate + activation gate added, threshold default 0** — see §8)

## 1. Problem Statement

- **What problem are we solving?** The `reasoning` parts on `compress`/`skill`-carrying assistant messages form a permanently-incompressible context floor: protection is message-granular, so the whole message (reasoning included) is excluded from compression and re-sent every turn. Each round adds ~9 KB of unreclaimable reasoning.
- **Why now?** Measured ~83.5% of the never-covered residual in a real long session (#368); it is a monotonic feedback loop that degrades long-session usability.

## 2. Goals & Non-Goals

- **Goals**:
  - Reclaim the reasoning floor at request time with zero loss of user-visible / compression-critical data.
  - Never break providers that require reasoning replay — enforced by the **provider allowlist gate** (fail-closed; review update 2026-09-08) + the **turn-closure gate** (the active round is always preserved).
  - Keep the sent prefix cache-stable within a turn.
- **Non-Goals**:
  - Part-granular protection rework (separate effort).
  - The three secondary findings A/B/C (separate issues).
  - Any persistent/DB write.

## 3. Current Architecture

The `experimental.chat.messages.transform` pipeline (`lib/hooks.ts`) runs, in order (relevant span):

```
:256 prune()
:257 truncateLargeToolOutputs()
:258 hideConsumedCompressCalls()   ← splices reasoning-only leftovers (reasoning is "structural")
:259 assignMessageRefs()
:262 injectCompressNudges(prePruneTokens)
:290 injectMessageIds()
:291 hideFailedCompressCalls()
:292 stripStaleMetadata()
:293 dropEmptyMessages()
:294 postTokens
```

Key facts (code-verified @ v1.14.27):
- `filterProtectedToolMessages` (`lib/compress/protected-content.ts:188-234`, `:202`) excludes the **whole** message (reasoning included) from every selection.
- `compress`/`skill` are default `compress.protectedTools` (`lib/config.ts:158`); `compress` is in `FORCE_COMPRESS_PROTECTED` (`:167`, force-appended `:476`).
- Excluded messages never enter `byMessageId`, so `prune` (`lib/messages/prune.ts:60-66`) re-sends them every turn.
- `lib/compress/parts.ts:1` `STRUCTURAL_PART_TYPES = ["step-start","step-finish","reasoning"]` → `hasMeaningfulContent()` is false on a reasoning-only leftover, so `hideConsumedCompressCalls` (`lib/compress/hide-consumed.ts:121-124`) **splices** consumed-block messages whose only remaining content is reasoning. **Therefore the only reasoning with no reclaim path is on (a) live-block compress calls and (b) skill-carrying messages** — exactly the floor this pass targets.
- `getLastUserMessage` (`lib/messages/query.ts:10`) returns the last user-role message that is **not** synthetic and **not** all-`ignored` (tool-result user msgs are ignored) — i.e. the last **genuine** user input. This is the turn boundary and is the same mechanism `stripStaleMetadata` already relies on.

## 4. Proposed Architecture

- **Overview**: A single request-time pass inserted **after** `hideConsumedCompressCalls` (operates on the minimal surviving set; never touches about-to-be-spliced messages) and **before** `assignMessageRefs`.

```
# request-level gates (evaluated once per request, before per-message iteration):
# Gate 0: provider allowlist — FAIL-CLOSED. allowedProviders !== undefined, "*" not in it,
#         and providerID undefined or not substring-matched → strip nothing.
# Gate 0.5: session activation — minMessages > 0 and messages.length < minMessages → strip nothing.

for each assistant message m at index i:
    if i >= lastGenuineUserIndex:                # Gate 1: current open round → KEEP
        continue
    if not hasProtectedToolPart(m):              # Gate 2: selector = protected tool call (compress/skill)
        continue
    if reasoningLength(m) <= threshold:          # Gate 3: size threshold (default 0 = strip all sizes)
        continue
    m.parts = m.parts.filter(p => p.type !== "reasoning")   # drop reasoning parts only, keep tool call
```

- **Key components**:
  - **Pass function** in `lib/messages/reasoning-strip.ts` (new export, name distinct from `stripStaleMetadata`; e.g. `stripProtectedReasoning`).
  - **Gate 1 — turn-closure**: `lastGenuineUserIndex = index of getLastUserMessage(messages)`. All assistant messages at/after it are the current (possibly-open) round → reasoning kept. Only messages strictly before are candidates. If `getLastUserMessage` returns `null` → strip nothing (fail-safe).
  - **Gate 2 — selector** (narrow, per operator): `m` contains a **protected tool part** (`compress`/`skill`). Only these are the "floor" — normal historical messages' reasoning is already reclaimed by compression, so we do **not** target arbitrary large-reasoning messages. (Simplified from the earlier "compress part OR all-non-structural-are-protected" predicate; confirm with owner.)
  - **Gate 3 — size threshold** (default `0` per review 2026-09-08): only strip when the message's total `reasoning` content length **exceeds the threshold**. Review rationale for 0: prefix-cache invalidation propagates from the **first divergent message** — as soon as one message in a turn is stripped, everything after it re-caches, so sparing small messages saves nothing once any large one is stripped. The measured mean is 9,418 B (max 28,067 B), far above any sensible threshold, so the gate is kept only as an operator knob; the **activation gate (Gate 5) is the cache lever**.
  - **Gate 4 — provider allowlist (ADDED per review 2026-09-08).** `compress.stripProtectedReasoningProviders: string[]`, default `["anthropic","gemini"]`; `"*"` = all providers. Matching is case-insensitive substring (`providerID.toLowerCase().includes(entry.toLowerCase())`). **Fail-closed**: `modelProviderID` undefined (older opencode builds / missing model info) or unmatched → the whole pass is a no-op, because GPT-family gateways may reject incomplete historical thinking. The call site passes `state.modelProviderID` (`lib/hooks.ts`). Explicit `[]` = strip for no provider (full opt-out at the strip level, distinct from the kill-switch which disables the pass entirely).
  - **Gate 5 — session activation (ADDED per review 2026-09-08).** `compress.stripProtectedReasoningMinMessages: number`, default `100`; `0` = always active. Below the threshold the pass is a byte-stable no-op, so short sessions (where the floor does not matter and any prefix churn is pure cost) never pay cache invalidation. This absorbs the issue-thread "turn-count-gated handling of ancient content" idea, scoped to the strip pass instead of compression itself.
  - **Action**: rebuild `m.parts` without `reasoning` parts (keep the tool call + any other non-reasoning parts). Message `info.id`/order unchanged → no effect on `mNNNNN` refs or downstream passes.
- **Data flow**: pure in-memory mutation of the per-request array. **No state/DB writes.** Deterministic → idempotent.
- **API / interface changes**: new config keys under `compress.*` (see §4 of REQ). No change to persisted state format, exported tool APIs, or internal `dcp` tags.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Gate axis | (a) provider-only; (b) turn-closure; (c) both | **(b) turn-closure** (+ provider gate §8) | Turn-closure keeps the mitigation active on high-thinking models while never touching the open round (the only case where replay actually matters). Provider-only would forfeit the biggest contributor. |
| Placement | before `hideConsumedCompressCalls`; after it | **after** (`:258`→`:259`) | Operates on the minimal surviving set; never processes messages about to be spliced. |
| What to strip | whole message; reasoning parts only | **reasoning parts only** | Dropping the whole message kills the live summary (it lives only in the compress-call body, `state.ts:55-63`). Reasoning has no value once the summary is finalized. |
| Predicate scope | any protected msg; only protected-exempt msgs | **only protected-exempt** (compress part, or all-non-structural-are-protected) | Narrow; never touches user-visible text or normal messages. |
| Provider policy | allowlist; blocklist; none | **allowlist, fail-closed** (review 2026-09-08) | Owner initially chose none ("provider 先不管 有问题再说"); the PR #370 review showed GPT-family gateways may 400 on incomplete historical thinking and recommended fail-closed `["anthropic","gemini"]` + `"*"` escape hatch; owner approved direct application ("直接修改pr"). |
| Naming | `stripExemptReasoning`; other | **distinct from `stripStaleMetadata`** | Avoids conceptual collision in `reasoning-strip.ts`. |
| Strip trigger | uniform; size-gated; session-activation-gated | **session-activation-gated** (`minMessages: 100`) + size threshold default 0 | Review: per-message size is cache-noise (invalidation propagates from the first stripped message); a request-level activation gate bounds churn to sessions large enough to have a floor. |

## 6. Impact Analysis

- **Backward compatibility**: additive config with safe defaults; no persisted-state or internal-tag changes.
- **Performance**: one O(n) pass per request (n = message count); negligible vs existing pipeline steps.
- **Cache**: prefix is byte-identical within a turn (strip set is fixed by the stable `lastGenuineUserIndex`). Invalidation is bounded to (a) turn-boundary shifts (≈ one prior turn's messages) and (b) a one-time rebuild on first enablement.
- **Security**: none (no new network/credential surface).
- **Dependencies**: none new.

## 7. Migration Plan

- **Steps**:
  1) Ship the pass + config behind the kill-switch.
  2) Default per owner decision (§8).
- **Feature flags / gradual rollout**: `compress.stripProtectedReasoning` (kill-switch) + provider-policy key. Can ship default-off (opt-in) if the owner prefers a burn-in release (the `qualityGate` precedent).

## 8. Open Questions (RESOLVED — owner decision 2026-09-07)

- [x] **Provider policy** — ~~none~~ → **allowlist, fail-closed** (updated 2026-09-08 review session; owner: "直接修改pr"). `["anthropic","gemini"]` default, `"*"` = all, case-insensitive substring; undefined/unmatched provider → no-op.
- [x] **Size-threshold default + unit** — ~~2048~~ → **0 chars** (updated 2026-09-08 review: cache-noise; activation gate is the lever). Unit = characters (matches `part.text.length`; cheap, no tokenizer).
- [x] **Session activation** — **ADDED 2026-09-08 review**: `stripProtectedReasoningMinMessages: 100` (0 = always). Small sessions keep a byte-stable prefix.
- [x] **Selector** — target = protected tool-call messages (`compress`/`skill`), NOT all large-reasoning messages. Confirmed.
- [x] **Default on/off** — **default-on** with the global kill-switch `stripProtectedReasoning: false`.
- [x] **Provider-ID matching** — case-insensitive substring against allowlist entries; `"*"` short-circuits.
