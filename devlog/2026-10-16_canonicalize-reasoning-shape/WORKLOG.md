# WORKLOG — Canonicalize historical thinking wire shape

**Branch**: `2026-10-16_canonicalize-reasoning-shape`
**Issue**: #482 · 来源: billion-context#3301

## Changes

| File | Change |
|------|--------|
| `lib/messages/reasoning-canonicalize.ts` | NEW — pure function `canonicalizeReasoningShape(messages: WithParts[]): number`. Per assistant message with non-empty reasoning content: join all reasoning parts (`""`) and all text parts (`""`), emit one synthesized text part `<thinking>\n{R}\n</thinking>\n{T}` (tag-only when no text) at the first folded slot; all other part types pass through in original order. Synthesized part reuses the first folded part's id + message/session ids. Returns number of normalized messages. |
| `lib/messages/index.ts` | Barrel export for the new module. |
| `lib/hooks.ts` | Import + one pipeline step after the #368 `dropCompressReasoning` block, before `ensureBuiltinFiltersRegistered()`: run normalization on `output.messages`, `logger.debug` when > 0. Ordering rationale: #368 drops oversized compress-call reasoning first so it is never merged into a canonical part; every later stage (token accounting, pruning, ref assignment) sees the post-normalization array. |
| `tests/reasoning-canonicalize.test.ts` | NEW — 12 pure-function cases (exact-byte canonical form, slot placement, tool/image pass-through identity, multi-part join parity, tag-only, empty-reasoning skip, non-assistant untouched, idempotence/byte stability, carrier-id reuse). |
| `devlog/2026-10-16_canonicalize-reasoning-shape/` | REQ.md / WORKLOG.md / DESIGN.md. |

## Design decisions (full rationale in DESIGN.md)

- **Canonical form = tagged merge**, not untagged merge or strip: the billion-context
  kernel recovers the tagged form back into split cores before identity derivation,
  so the pinned shape mints exactly the same ids as the split `reasoning_content`
  form — existing anchors keep matching without alias registration.
- **All assistant messages, no closed-turn gate**: relocation (not deletion) is
  uniform across history; determinism maximization beats turn-boundary bookkeeping.
- **Runs after #368 drop, before accounting/pruning**: dropped reasoning stays
  dropped; all downstream stages see stable bytes.
- **No config surface added** (owner-gated discipline): default-on behavior change,
  disclosed in PR + issue.

## Verification

- `npm run typecheck` — PASS
- `node --import tsx --test tests/reasoning-canonicalize.test.ts` — 11/11 PASS
- `npm run build` — PASS
- Full suite verdict: remote CI (`pr-checks.yml` + test lanes) on the pushed head.

## Review status

- Dual-agent review of `lib/` source + new tests (§5.3/§5.6): PENDING — requested
  in PR thread.
- Human merge: required (§5.1.1.2).
