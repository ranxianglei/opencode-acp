# WORKLOG - README v3 (two-point focus)

- Task ID: `2026-06-27_readme-v3`
- Status: Done
- Updated: 2026-06-27

## Summary

Docs-only revision focusing "Why ACP" on two points (saves tokens; long sessions
without losing key content) and reworking "Proven at scale" to only the two
sessions with a full context-distribution table + message counts.

## Changes (README.md + README.zh-CN.md)

- **Why ACP**: replaced the 7-bullet feature list + DCP comparison table with two
  H3 subsections:
  1. *It saves tokens — a lot* — summaries are 2–6% of original (94–98% reduction),
     p95 context ~30%, 2.6M/1.8M reclaimed.
  2. *Supports very long sessions without losing key content* — model CRUD over
     context (compress/decompress/mark_block), 100,000-message ceiling.
  - 37 bug fixes demoted to a one-line footnote (no comparison table).
  - Dropped: pressure-aware GC, two modes, protected content, strategies,
    production-config bullets.
- **Proven at scale**: dropped the 1,445-session global aggregate. Kept only
  Session 1/2, now as a vertical table with span / **messages** / turns / total
  tokens / reclaimed / summary-% / cache-hit, plus a separate per-turn context
  distribution table (p50/p75/p90/p95/p99/peak). Added the 100K-message note.

## Verification

Docs-only. No project names remain (`grep` clean). The only "garbage collection"
mention left is in a config code-comment (line ~309), not in the Why-ACP prose.

## Notes

Per user request, this PR targets the **Gitea** fork (dog/opencode-acp) so an
accidental merge only affects the local fork, not the GitHub main project. Will
NOT be self-merged — awaiting explicit user approval.
