# DESIGN - Visible Range Guidance & Compression Failure Recovery

- Task ID: `2026-07-05_visible-range-guidance`
- Home Repo: `opencode-acp`
- Created: 2026-07-05
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** The model operates blind to which `mNNNNN`
  refs are still compressible. After a batch is folded into a block, the
  consumed IDs silently disappear, but the model remembers them from prior
  turns and retries them — failing with unhelpful errors.
- **Why now?** A real compression failure on a 1M-context session (issue #9)
  blocked work for several turns. The root cause is informational, not
  algorithmic: the data exists in `CompressionBlock` metadata but is never
  surfaced to the model at the right moments.

## 2. Goals & Non-Goals

- **Goals**:
    - Surface the four context tools and their usage patterns in the system
      prompt so the model can self-serve visibility info.
    - Drive nudge cadence off the 5% growth signal alone (no separate floor).
    - Make `acp_status` the canonical "what's been compressed" lookup, with
      sizing and ID-range metadata per block.
    - Make compression failures self-recoverable in one retry.
- **Non-Goals**:
    - Rewrite the nudge text body (block B). Deferred pending experiments.
    - Touch the persisted state schema.
    - Add new config fields.

## 3. Current Architecture (if applicable)

- **How it works today**:
    - System prompt (`lib/prompts/system.ts`) mentions 3 of 4 tools and uses the
      word `promptly` which triggers over-compression.
    - `computeShouldNudge` (`lib/messages/inject/utils.ts:212`) gates on
      `contextPct >= minNudgeContextPercent (15%)` AND `frequencyTriggered`.
      First-turn short-circuit (`lastNudgeTokens === undefined`) forces a nudge.
    - `acp_status` (`lib/compress/status.ts`) lists active blocks with
      `summaryTokens`, age, and topic only — no `compressedTokens`, no ID range.
    - `resolveBoundaryIds` (`lib/compress/search.ts:47`) throws a generic
      "is not available" error with no context about what IS available.
- **Pain points**: All four are independent visibility gaps that compound.

## 4. Proposed Architecture

- **Overview**: Four independent, independently-revertible changes (blocks
  A/C/D/E) that together give the model enough information to choose correct
  compress boundaries and recover from stale-ID mistakes.
- **Key components**:
    - Block A — System prompt rewrite (cached every turn).
    - Block C — `computeShouldNudge` pure logic + baseline-establishment in
      `inject.ts`.
    - Block D — `acp_status` tool upgrade (args + display fields).
    - Block E — `resolveBoundaryIds` enriched error string.
- **Data flow**: Unchanged. No new persisted fields, no new hook wiring.
- **API / interface changes**:
    - `acp_status` gains optional `mode`, `sort`, `limit` args (backward compatible
      — existing no-arg calls still work with defaults).
    - `computeShouldNudge` keeps its param shape; `minNudgeContextPercent` becomes
      a no-op (kept for callers/config compatibility).

## 5. Design Decisions & Rationale

| Decision                              | Options Considered                                            | Chosen                           | Why                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| First-turn nudge behavior             | (a) force nudge (b) silent baseline (c) nudge if overMinLimit | (b) silent baseline              | User's example: 6% start → 11% nudge. First turn sets `lastNudgeTokens = currentTokens` and returns false. |
| Visible-range cadence                 | (a) every turn (b) 5% growth (c) only on failure              | (b) 5% growth                    | Every-turn causes over-compression (maintainer experiment); failure-only is too late.                      |
| Where to put block sizes              | (a) in nudge suffix (b) in acp_status only                    | (b) acp_status only              | Suffix must stay bounded; acp_status is opt-in and `limit`-capped.                                         |
| `minNudgeContextPercent` config field | (a) remove from schema (b) keep as no-op                      | (b) keep as no-op                | Avoids breaking existing user configs; field becomes deprecated.                                           |
| Error message scope                   | (a) full gap list (b) first/last + count + pointer            | (b) first/last + count + pointer | Full list could overflow; pointer lets model self-serve detail.                                            |
| System prompt tool list               | (a) bullet list (b) inline sentence                           | (a) bullet list                  | Scannable; easier to add "when to use" per tool.                                                           |

## 6. Impact Analysis

- **Backward compatibility**:
    - Config: `minNudgeContextPercent` still parsed, now ignored. No migration.
    - State: no schema changes.
    - Tool API: `acp_status` args all optional; existing callers unaffected.
- **Performance**:
    - System prompt grows ~300-500 tokens, but it's cached every turn so net
      cost is near zero after first turn.
    - `acp_status` adds O(N log N) sort for `size`/`age` modes; bounded by
      `limit` (default 30).
    - `computeShouldNudge` unchanged complexity.
- **Security**: No new attack surface (no new external I/O, no eval).
- **Dependencies**: None new.

## 7. Migration Plan (if applicable)

- **Steps**:
    1. Ship blocks A/C/D/E in one PR.
    2. Maintainer runs real-session experiments (block B phase 2) to tune nudge
       wording separately.
- **Feature flags / gradual rollout**: None — changes are prompt/UX only, no
  persisted-state risk.

## 8. Open Questions

- [ ] Should `acp_status` `detailed` mode also include `consumedBlockIds`
      (nested block lineage)? Deferred — not needed for boundary recovery.
- [ ] Should the enriched compress-failure error also list the most-recent
      3 blocks' ID ranges? Deferred — `acp_status` call is one step away and
      keeps the error string bounded.
