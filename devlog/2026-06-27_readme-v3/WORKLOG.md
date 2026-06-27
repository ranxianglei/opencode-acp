# WORKLOG - README v5 (GitHub PR #21)

- Task ID: `2026-06-27_readme-v5`
- Status: Done
- Updated: 2026-06-27

## Summary

Docs-only README refinement, 5 rounds of user feedback consolidated into a
focused, model-driven framing. EN + ZH kept consistent. No code changes, no
version bump.

## Changes (README.md + README.zh-CN.md)

- **Why ACP**: one paragraph (model owns all context authority; best on market) +
  two bullets (saves ~2/3 tokens — 1M window runs in 200K–300K; ultra-long
  sessions — 500M-level context, 100K messages). Units unified (EN full numbers,
  ZH 万). Old 37-bug-fixes footnote + DCP comparison table removed from this
  section.
- **Proven at scale**: one-line summary lead (500M-level, p95 ~30%, avg cache hit
  >85%, flagged average-not-per-session); single horizontal table (messages,
  total tokens, cache hit, p50–p99, peak); dropped span/turns/reclaimed rows.
- **How It Works**: model 100% responsible; tools = compress/decompress/delete.
  3-object mermaid lifecycle (Raw ⇄ Compressed → Deleted). Compression strategy
  with the source priority list (`lib/prompts/system.ts`). Decompression +
  Deletion strategies. Deletion framing kept as "delete" per user's Option B
  decision (mark_block = conceptual deletion; mechanism not elaborated).
- **Impact on Prompt Caching**: relocated to immediately after How It Works.

## Dual-agent review (AGENTS.md §5.3) — both reviewers
- README content: APPROVE-quality on all checks (scope, EN↔ZH parity, section
  order, math, units, mermaid, footnote removal).
- Two findings raised, both resolved:
  1. mark_block/"delete" framing vs source — **resolved per user Option B**
     (keep "delete"; it's conceptually deletion).
  2. devlog staleness (this file described v3, not v5) — **resolved** by
     rewriting REQ.md + WORKLOG.md to match the actual v5 diff (this update).

## Verification
Docs-only — no `lib/` touched. No project/session names leak (anonymized).
Language cross-links present in both READMEs.

## Notes
- Branch pushed to GitHub via the git database API (direct `git push` to
  github.com:443 times out in this env; `api.github.com` reachable).
- Awaiting explicit user merge approval — not auto-merged.
