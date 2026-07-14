# REQ - Visible Range Guidance & Compression Failure Recovery

- Task ID: `2026-07-05_visible-range-guidance`
- Home Repo: `opencode-acp`
- Created: 2026-07-05
- Status: InProgress
- Priority: P1
- Owner: awork
- References: gitea dog/opencode-acp#9

## 1. Background & Problem Statement

- **Context**: Long-running sessions on large-context models (1M+). A compression
  failure was reported: model called `compress(startId=m00930, endId=m00943)` but
  those IDs had already been folded into a previous compression block (b59/b60).
- **Current behavior (symptom)**:
    1. Model has no stable view of which `mNNNNN` refs are currently compressible.
       The only visible-range injection (`[Visible messages: ...]`) is gated behind
       `shouldNudge`, which on 1M models only fires every ~50K tokens of growth.
    2. When compression fails on a consumed ID, the error message
       (`search.ts:resolveBoundaryIds`) says "Choose an injected ID visible in
       context" but provides zero recovery info — the model retries blindly and
       wastes turns.
    3. `acp_status` tool is registered but **not mentioned in the system prompt**,
       so the model doesn't know when to call it proactively.
    4. The system prompt's "compress obvious waste promptly" wording is a known
       over-compression trigger (per maintainer's prior experiments).
    5. `computeShouldNudge` requires `contextPct >= 15%` before any nudge fires,
       suppressing visibility info at low context usage entirely.
- **Expected behavior**:
    - System prompt lists all 4 context tools with usage guidance and explicit
      compress / do-not-compress scenes.
    - Nudge frequency driven purely by 5% growth increments (no 15% floor, no
      first-turn force); first turn establishes a baseline instead.
    - `acp_status` exposes `mode`/`sort`/`limit` plus per-block sizes and the
      `mNNNNN` ranges each block consumed.
    - Compression failures return the current visible range + block count and
      point the model at `acp_status` for details.
- **Impact**: Reduces failed-compress retries, prevents over-compression from
  ambiguous prompts, and lets the model self-recover from stale-ID mistakes
  without human intervention.

## 2. Reproduction (if applicable)

- **Environment**:
    - Node 22/24, opencode-acp plugin on a 1M-context provider
- **Minimal reproduction steps**:
    1. Run a long session that crosses multiple compression batches.
    2. Once a batch compresses m00900-m00943 into b60, observe the model later
       attempts `compress(..., endId="m00943")`.
    3. Compression throws "is not available" with no recovery info; the model
       retries with another stale ID and wastes a turn.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: do not break persisted state schema, exported APIs,
      or existing config fields. `minNudgeContextPercent` config field stays
      (treated as deprecated/ignored, not removed).
    - Performance: visible-range injection must remain O(1) size; no per-message
      loops added to hot paths.
    - Prefix-cache friendliness: the periodic nudge block stays in the synthetic
      suffix message (not system prompt) to avoid invalidating cache every turn.
- **Non-Goals** (explicitly out of scope):
    - Rewriting nudge text content (block B) — deferred to a separate iteration
      pending real-session experiments.
    - Changing the 5% adaptive `nudgeGrowthTokens` default.
    - Persisting visible-range info across restarts.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] System prompt names all four tools (`compress`, `decompress`,
          `search_context`, `acp_status`) with a one-line "when to use" hint each.
    - [ ] System prompt contains both a "compress these scenes" and a
          "do-not-compress these scenes" list, and no longer contains the word
          `promptly`.
    - [ ] `computeShouldNudge` returns `shouldNudge: false` on the first call
          (when `lastNudgeTokens === undefined`), regardless of token count.
    - [ ] `computeShouldNudge` no longer enforces a `contextPct >= floor` gate.
    - [ ] `acp_status` accepts `mode` (`summary`|`detailed`), `sort`
          (`recent`|`size`|`age`), and `limit`; each block row shows
          `compressedTokens→summaryTokens` and the `mNNNNN` range it consumed.
    - [ ] `resolveBoundaryIds` failure error includes the current visible range
          (first/last ref), the active block count, and a pointer to `acp_status`.
- **Performance / Stability**:
    - [ ] No new per-turn O(n) loops on the message-transform hot path.
    - [ ] `acp_status` output stays bounded by `limit` (default 30).
- **Regression**:
    - [ ] All existing tests pass or are explicitly updated for the new behavior.
    - [ ] New tests added covering: first-turn baseline, growth-triggered nudge
          without floor, acp_status sort/limit/modes, enriched failure error.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/prompts/system.ts` — rewrite tool listing + scenes.
    - `lib/messages/inject/utils.ts` — `computeShouldNudge` logic.
    - `lib/messages/inject/inject.ts` — establish baseline on first observed turn.
    - `lib/compress/status.ts` — `acp_status` multi-mode/sort/limit + ranges.
    - `lib/compress/search.ts` — enriched failure error in `resolveBoundaryIds`.
- **Risks**:
    - Removing the 15% floor may increase nudge frequency on small-context models.
      Mitigation: keep the 5% adaptive growth gate (which is floored at 6K tokens).
    - System prompt rewrite could change model behavior unpredictably.
      Mitigation: keep the wording factual and avoid imperative verbs.
- **Rollback strategy**: Revert the per-block commits independently; each block
  (A/C/D/E) is committed separately.
