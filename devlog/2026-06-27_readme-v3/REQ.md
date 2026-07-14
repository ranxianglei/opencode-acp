# REQ: README v5 — model-driven focus (GitHub PR #21)

- Task ID: `2026-06-27_readme-v5` (devlog folder retains earlier `readme-v3` name)
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: Done
- Priority: P2
- Owner: awork (glm-5.2)
- References: dog/opencode-acp#3 (5 rounds of user README feedback); GitHub PR #21

## Background

After PR #18/#19/#20 (v1.4.0 release) merged, the README went through 5 rounds of
user feedback. This iteration (v5, PR #21) is the consolidated result: a focused,
model-driven framing with consistent units and a reordered structure.

## What shipped (v5)

### "Why ACP"

One paragraph: _ACP hands all context-management authority to the model itself —
not relying on external models or complex mechanisms; the best implementation to
date._ Two effects, as bullets:

1. **Saves about two-thirds of tokens** — a 1,000,000-token window effectively
   runs in the 200,000–300,000 range.
2. **Ultra-long sessions without losing key content** — 500M-token-level
   cumulative context, 100,000 messages per session.

- The old "37 bug fixes" footnote + DCP comparison table were **removed** from
  Why ACP (the 37-fix list survives only as a collapsible in "Migrating from DCP").

### "Proven at scale"

- One-line summary lead: supports 500M-level context, p95 ~30%, **average** cache
  hit >85% (explicitly noted as average, not per-session; cross-references the
  cache section).
- Single horizontal table (Session 1 / Session 2): Messages, Total tokens
  processed, Prompt-cache hit ratio, and the per-turn context distribution
  (p50/p75/p90/p95/p99/Peak). Dropped: span, model turns, tokens-reclaimed rows.
- Footnote: context percentages are of the 1M window.

### "How It Works"

- Model is 100% responsible; tools = compress / decompress / delete
  (`mark_block` / `unmark_block`).
- Lifecycle: 3-object mermaid state diagram (Raw ⇄ Compressed → Deleted).
- Compression strategy with the source priority list (from `lib/prompts/system.ts`:
  agent results, verbose command output, dead-end exploration, redundant tool
  results, intermediate steps, resolved discussions, large files).
- Decompression strategy (model decides when).
- Deletion strategy (model decides; once deleted, irrecoverable; replaces forced
  GC). **Per user decision (Option B), the "delete" framing is retained** —
  mark_block is conceptually deletion (mark → eventually truly deleted); the
  merge-vs-true-delete mechanism is intentionally not elaborated in the README.

### "Impact on Prompt Caching" — MOVED

Relocated to sit **immediately after "How It Works"** (was near the end).
Content: ~87% hit rate; beats traditional compression (which acts at 80–90% +
forces full re-hit); ACP keeps context ~30% vs traditional 50–80%; conclusion =
higher hit rate AND no key info lost.

## Verified data

- 100K message cap: `MESSAGE_REF_MAX_INDEX = 99999` (`lib/message-ids.ts`).
- Sessions: 3,024 / 2,028 messages; 582M / 463M total tokens; cache hit 86.2% /
  89.0%; context percentiles verified against `~/.local/share/opencode/opencode.db`.

## Non-goals

- No version bump (1.4.0 already on npm).
- LICENSE unchanged (AGPL-3.0-or-later; MIT relicense not legally possible on an
  AGPL fork).
- README deletion framing kept as "delete" per user's explicit decision.
