# REQ: README v2 — step out of DCP's shadow (docs revision)

- Task ID: `2026-06-27_readme-v2-step-out-of-dcp`
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: Done
- Priority: P2
- Owner: awork (glm-5.2)
- References: dog/opencode-acp#3 (user feedback on PR #18's README)

## 1. Background

PR #18 added a "Proven at scale" section and expanded the DCP comparison table to
13 rows. User feedback identified three problems:

1. **Privacy**: the two example sessions were labeled by real project name
   (`compute-problem`, `model-editing`) — leaks what was being worked on.
2. **Metric framing**: the headline emphasized peak context + cache hit, but the
   more meaningful numbers are (a) **total tokens pushed through the model per
   session** (user expected ≥500M) and (b) the **context distribution** (median /
   p95 / where context sits most of the time), not just the peak.
3. **DCP overshadowing**: the 13-row DCP comparison table was too long and the
   README led with "fork of DCP" framing instead of ACP's own capabilities.

## 2. Acceptance Criteria

- [x] Sessions anonymized to "Session 1 / Session 2" (会话一/会话二) — no project
      names anywhere in the READMEs.
- [x] "Proven at scale" leads with total tokens per session, adds p50/p95/peak
      context distribution.
- [x] "Why ACP" rewritten to lead with ACP's own features (model-driven lifecycle,
      cache-aware, pressure-aware GC, two modes, protected content, strategies,
      config); DCP demoted to a short "hardened fork" subsection with a 4-row table.
- [x] 37 bug fixes mentioned as a secondary one-liner, not the lead.
- [x] Both EN and ZH READMEs updated consistently.

## 3. Source data (computed from opencode.db)

| Session   | Span | Turns | Total tokens | Cache hit | ctx p50    | ctx p95    | Peak       |
| --------- | ---- | ----- | ------------ | --------- | ---------- | ---------- | ---------- |
| Session 1 | 6d   | 2,694 | 582 M        | 86.2%     | 1.2K (<1%) | 251K (25%) | 488K (49%) |
| Session 2 | 2d   | 1,536 | 463 M        | 89.0%     | 1.8K (<1%) | 335K (34%) | 769K (77%) |

Global (1,445 sessions): 6.17B total processed, 828M billable, ~87% cache hit.
