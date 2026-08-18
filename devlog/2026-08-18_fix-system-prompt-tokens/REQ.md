# REQ - Stabilize system prompt token estimate (#255)

- Task ID: `2026-08-18_fix-system-prompt-tokens`
- Home Repo: `opencode-acp`
- Created: 2026-08-18
- Status: Done
- Priority: P1
- Owner: beatrice
- References: Issue #255

## 1. Background & Problem Statement

- **Context**: `estimateSystemPromptTokens()` (`lib/token-utils.ts`) derives the
  system prompt token estimate from the _first visible assistant message_ with
  token data (`tokens.input + cache.read + cache.write` minus first user text).
  After ACP compression, `prune()` (`lib/messages/prune.ts:52-90`,
  `filterCompressedRanges`) physically removes compressed messages from the
  transform array. The first visible assistant then belongs to a much later
  turn, whose `input` includes a large accumulated history — inflating the
  system prompt estimate to roughly the size of the whole context.
- **Current behavior (symptom)**: nudge (`estimateContextComposition` in
  `lib/messages/inject/utils.ts:565`) and `acp_status`
  (`lib/compress/status.ts:175`) each re-derive the system estimate from their
  own message views (post-prune transform array vs. fresh store fetch), so the
  two numbers diverge and both can be wildly overestimated.
- **Expected behavior**: once a reliable positive `state.systemPromptTokens` has
  been measured (before compression removed the true first assistant), nudge and
  `acp_status` both use that stable cached value; later compression/compaction
  of visible messages must not overwrite or invalidate it.
- **Impact**: wrong system prompt numbers mislead both the model (nudge
  breakdown, compressibleTokens = total − systemTokens − ...) and the user
  (`acp_status` breakdown).

## 2. Reproduction (if applicable)

- **Environment**:
    - Node: 22+
    - OS/Arch: linux-x64
- **Minimal reproduction steps**:
    1. Session with first assistant input ≈ `system + first user` (system ≈ 10_000).
    2. ACP compression removes the first assistant from visible messages.
    3. First _visible_ assistant input ≈ `system + large history` (≈ 200_000).
    4. nudge `estimateContextComposition` reports system ≈ 200_000 while the
       cached `state.systemPromptTokens` is 10_000.
- **Relevant configuration**: default ACP config.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: `state.systemPromptTokens` may be `undefined`;
      all readers must fall back to the existing
      `estimateSystemPromptTokens(messages)` behavior unchanged.
    - Performance requirements: no new per-turn computation; reuse the cache.
    - Resource limits: none.
- **Non-Goals** (explicitly out of scope, per human review of prior
  investigation):
    - No persistence changes (`PersistedSessionState` / save/load stay untouched).
    - No model/provider identity invalidation.
    - No `/acp context` changes (separate surface; not required to satisfy #255).
    - No `lib/token-utils.ts` refactor; `estimateSystemPromptTokens()` public
      semantics unchanged.
    - No `package.json` version change.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] `cacheSystemPromptTokens()`: once `state.systemPromptTokens` holds a
          positive value, subsequent calls with a degraded messages array (first
          visible assistant input ≈ 200_000) must NOT overwrite it (stays 10_000).
    - [x] `estimateContextComposition()`: with `state.systemPromptTokens = 10_000`
          and a degraded messages array, `composition.systemTokens === 10_000`
          (not ≈ 200_000).
    - [x] `acp_status` uses the same cached value (if test structure allows).
- **Performance / Stability**: no new per-turn work; cache read is O(1).
- **Regression**:
    - [x] New/modified test cases added to test suite and passing
          (`tests/inject-utils-pure.test.ts` + cache overwrite regression).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/ui/utils.ts` — `cacheSystemPromptTokens`: write-if-undefined guard.
    - `lib/messages/inject/utils.ts` — `estimateContextComposition`: prefer
      `state?.systemPromptTokens` over fresh estimate.
    - `lib/compress/status.ts` — `collectVisibleMessages`: prefer
      `ctx.state.systemPromptTokens` over fresh estimate.
    - `tests/inject-utils-pure.test.ts` — regression tests.
- **Risks**: low — readers only prefer the cache when it is a positive number;
  `undefined` preserves current behavior exactly.
- **Rollback strategy**: revert the three file changes; tests would then fail
  (proving they target the fix).
