# DESIGN - Stabilize system prompt token estimate (#255)

- Task ID: `2026-08-18_fix-system-prompt-tokens`
- Home Repo: `opencode-acp`
- Created: 2026-08-18
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** After ACP compression removes the true first
  assistant message from visible history, nudge and `acp_status` re-derive the
  system prompt token estimate from the _first visible assistant_ — a much later
  turn whose `input` includes large accumulated history. Both inflate the
  estimate, and because each consumer sees a different message view (post-prune
  transform array vs. fresh store fetch), the two numbers diverge.
- **Why now?** Issue #255. The `SessionState.systemPromptTokens` field and its
  writer (`cacheSystemPromptTokens`) already exist but have no readers — the
  missing link is wiring consumers to the cache.

## 2. Goals & Non-Goals

- **Goals**:
    - nudge and `acp_status` use the same stable system prompt token estimate
      after compression changes visible messages.
    - Preserve existing behavior exactly when no cache exists (`undefined`).
- **Non-Goals** (per human review of the investigation phase):
    - No persistence of `systemPromptTokens` (survives only in-session).
    - No model/provider identity invalidation.
    - No `/acp context` changes.
    - No refactor of `lib/token-utils.ts`; `estimateSystemPromptTokens()` public
      semantics unchanged.

## 3. Current Architecture

**How it works today:**

```
estimateSystemPromptTokens(messages)   # token-utils.ts
  ↑ 现算 ×4（互不共享）
nudge:    injectCompressNudges → estimateContextComposition → estimateSystemPromptTokens(messages)
acp_status: collectVisibleMessages → estimateSystemPromptTokens(rawMessages)
/acp stats: buildStatusReport（同 acp_status）
/acp context: analyzeTokens（内联实现）

cacheSystemPromptTokens(state, output.messages)  # hooks.ts:233，prune 前，每轮写入
  → state.systemPromptTokens（存在，但无人读取）
```

**Pain points:**

- nudge runs after `prune` (hooks.ts:253 > 247); `filterCompressedRanges`
  physically removes compressed messages from the array → first visible
  assistant is a late turn → inflated estimate.
- `acp_status` fetches fresh from the store → different view → inconsistent
  numbers.

## 4. Proposed Architecture

**Overview (text diagram):**

```
pre-prune transform  (hooks.ts:233)
  → cacheSystemPromptTokens(state, output.messages)
      → state.systemPromptTokens  ← write-if-undefined（首测后不再覆盖）
        ↓
nudge  estimateContextComposition → state?.systemPromptTokens ?? 现算
acp_status  collectVisibleMessages → ctx.state.systemPromptTokens ?? 现算
undefined 时：fallback 到 estimateSystemPromptTokens(messages)（旧行为）
```

**Key components:**

- `lib/ui/utils.ts` — `cacheSystemPromptTokens`: write-if-undefined guard.
- `lib/messages/inject/utils.ts` — `estimateContextComposition`: prefer cache.
- `lib/compress/status.ts` — `collectVisibleMessages`: prefer cache.

**Data flow:** pre-prune cache → `SessionState.systemPromptTokens` → both
consumers → `undefined` fallback to old estimate.

**API / interface changes:** none (fields/functions already exist).

## 5. Design Decisions & Rationale

| Decision                    | Options Considered                                               | Chosen             | Why                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache source                | first measurement wins (write-if-undefined) vs. always overwrite | write-if-undefined | After compression the array is degraded; overwriting would corrupt the stable value. `undefined` stays `undefined` (never cache undefined). |
| Reader fallback             | hard-require cache vs. `?? estimateSystemPromptTokens`           | `??` fallback      | Backward compat: old/restart states lack the field; behavior identical to pre-fix master when `undefined`.                                  |
| Persistence                 | persist vs. in-session only                                      | in-session only    | Per human scope decision; a restart re-measures on first pre-prune transform. Known limitation (see §8).                                    |
| Model identity invalidation | add vs. skip                                                     | skip               | Per human scope decision; no evidence of mid-session model-switch churn; would expand blast radius.                                         |
| `/acp context`              | unify vs. leave                                                  | leave              | Separate surface; not required to satisfy #255. Would be scope expansion.                                                                   |

## 6. Impact Analysis

- **Backward compatibility:** full — optional field, `undefined` fallback keeps
  old behavior byte-for-byte.
- **Performance:** cache read is O(1); saves the existing per-consumer estimate
  work in the common (cached) path.
- **Security:** none.
- **Dependencies:** none.

## 7. Migration Plan

- **Steps:** not applicable — no persisted state changes, no config changes.
- **Feature flags:** none.

## 8. Open Questions / Known Limitations

- Plugin restart: cache is re-measured on the first pre-prune transform. If
  OpenCode compaction has already dropped the true first assistant from the
  store, the re-measured value is degraded — out of scope for #255 (would need
  persistence).
- AGENTS.md / project instruction changes mid-session do not actively invalidate
  the cache — out of scope for #255 (would need model-identity or file-watch
  invalidation).
