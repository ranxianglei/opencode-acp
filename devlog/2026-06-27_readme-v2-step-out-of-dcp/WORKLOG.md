# WORKLOG - README v2 (step out of DCP's shadow)

- Task ID: `2026-06-27_readme-v2-step-out-of-dcp`
- Status: Done
- Updated: 2026-06-27

## Summary

Docs-only revision of both READMEs to (1) anonymize the example sessions, (2)
reframe "Proven at scale" around total tokens + context distribution instead of
peak context, and (3) lead with ACP's own features instead of the DCP fork
comparison.

## Changes

- `README.md` + `README.zh-CN.md`:
    - **Why ACP**: rewrote to lead with a "What makes ACP different" feature list
      (model-driven block lifecycle, cache-aware design, pressure-aware GC, two
      compression modes, protected content, automatic strategies, production
      config). DCP comparison table trimmed 13 rows → 4 rows and moved into a
      short "A hardened fork of DCP" subsection. 37 bug fixes reduced to a
      secondary one-liner.
    - **Proven at scale**: anonymized sessions (compute-problem → Session 1,
      model-editing → Session 2). Reframed the per-session table around **total
      tokens processed** (582M / 463M) and added a context-distribution breakdown
      (p50 / p95 / peak). Dropped the standalone "cache hit tokens" row; cache hit
      stays as a column + supporting sentence.

## Verification

Docs-only change — no `lib/` touched, no build/typecheck/test impact. Confirmed
no project names remain in either README (`grep` clean). Markdown tables
re-validated by inspection.

## Follow-ups

- This PR (#19) merges after user review, then the 1.4.0 release commit bumps
  version + tags + publishes.
