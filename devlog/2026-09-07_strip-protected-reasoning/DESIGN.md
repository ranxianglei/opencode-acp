# DESIGN - Strip reasoning from protected-exempt historical messages

- Task ID: `2026-09-07_strip-protected-reasoning`
- Home Repo: `opencode-acp`
- Created: 2026-09-07
- Status: Final (owner decision 2026-09-07: **no provider gate**, default-on, threshold 2048 chars — see §8)

## 1. Problem Statement

- **What problem are we solving?** The `reasoning` parts on `compress`/`skill`-carrying assistant messages form a permanently-incompressible context floor: protection is message-granular, so the whole message (reasoning included) is excluded from compression and re-sent every turn. Each round adds ~9 KB of unreclaimable reasoning.
- **Why now?** Measured ~83.5% of the never-covered residual in a real long session (#368); it is a monotonic feedback loop that degrades long-session usability.

## 2. Goals & Non-Goals

- **Goals**:
  - Reclaim the reasoning floor at request time with zero loss of user-visible / compression-critical data.
   - Never break providers that require reasoning replay — enforced by the **turn-closure gate** (the active round is always preserved). No provider gate (owner decision); residual cross-turn risk handled reactively via the kill-switch.
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
for each assistant message m at index i:
    if i >= lastGenuineUserIndex:                # Gate 1: current open round → KEEP
        continue
    if not hasProtectedToolPart(m):              # Gate 2: selector = protected tool call (compress/skill)
        continue
    if reasoningLength(m) <= threshold:          # Gate 3: size threshold → small reasoning untouched
        continue
    m.parts = m.parts.filter(p => p.type !== "reasoning")   # drop reasoning parts only, keep tool call
```

- **Key components**:
  - **Pass function** in `lib/messages/reasoning-strip.ts` (new export, name distinct from `stripStaleMetadata`; e.g. `stripProtectedReasoning`).
  - **Gate 1 — turn-closure**: `lastGenuineUserIndex = index of getLastUserMessage(messages)`. All assistant messages at/after it are the current (possibly-open) round → reasoning kept. Only messages strictly before are candidates. If `getLastUserMessage` returns `null` → strip nothing (fail-safe).
  - **Gate 2 — selector** (narrow, per operator): `m` contains a **protected tool part** (`compress`/`skill`). Only these are the "floor" — normal historical messages' reasoning is already reclaimed by compression, so we do **not** target arbitrary large-reasoning messages. (Simplified from the earlier "compress part OR all-non-structural-are-protected" predicate; confirm with owner.)
  - **Gate 3 — size threshold** (operator proposal, 2026-09-08): only strip when the message's total `reasoning` content length **exceeds a configurable threshold** (default ~2 KB, unit pending). Small reasoning is left untouched → zero prefix churn for those messages, and the per-message decision is stable (length doesn't change). Captures ~all of the floor (measured mean 9,418 B, max 28,067 B per message).
   - **~~Gate 4 — provider policy~~ (removed per owner decision 2026-09-07).** No provider gate is implemented ("provider 先不管 有问题再说"). The turn-closure gate (Gate 1) is the safety mechanism; the global kill-switch is the self-service mitigation; a provider gate would be added reactively if a real breakage is reported. (`state.modelProviderID` remains available at the call site — `lib/hooks.ts:92,104,197,215` — should a gate be added later.)
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
| Provider policy | allowlist; blocklist; none | **none (owner decision 2026-09-07)** | Owner: "provider 先不管 有问题再说". Turn-closure gate + global kill-switch are the safeguards; a gate is added reactively only on a real breakage. |
| Naming | `stripExemptReasoning`; other | **distinct from `stripStaleMetadata`** | Avoids conceptual collision in `reasoning-strip.ts`. |
| Strip trigger | uniform (all protected msgs); size-gated | **size-gated** (threshold, default ~2 KB) | Operator proposal: floor is dominated by large reasoning (mean 9.4 KB), so size-gating captures ~all benefit while leaving small reasoning untouched → smaller cache-invalidation surface + a stable per-message decision. |

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

- [x] **Provider policy** — **none** ("provider 先不管 有问题再说"). Turn-closure gate + global kill-switch are the safeguards; a provider gate is added reactively only if a real breakage is reported.
- [x] **Size-threshold default + unit** — **2048 chars** (owner: "阈值按照你的推荐"). Unit = characters (matches the `part.text.length` measurement; cheap, no tokenizer).
- [x] **Selector** — target = protected tool-call messages (`compress`/`skill`), NOT all large-reasoning messages. Confirmed.
- [x] **Default on/off** — **default-on** with the global kill-switch `stripProtectedReasoning: false`.
- [x] **Provider-ID matching** — moot (no provider gate).
