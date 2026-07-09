# WORKLOG: Protected Tool Accumulation Proposal

## 2026-07-09

### Analysis Phase

- Queried session database directly (SQLite + JSON parsing) to analyze ~500 tool calls across a long session
- Categorized visible small tool calls (<0.5K tok each) by tool type: bash, todowrite, write, edit, read
- Deep-dived `write` tool: discovered 51K tok is NOT "all success echoes" but split into ~29K file content (input) + ~12K hook output + ~4K markdown + misc
- Spot-checked 5 compression blocks for quality control: all rated Good–Excellent
- Identified root cause: protected tools accumulate because they're never inside compressed ranges (model compresses big outputs, not scattered small calls)

### Design Phase

- Wrote `DESIGN.md` with sanitized analysis (no local paths, session IDs, or project-specific content)
- Proposed 5 solutions (A–E) ranked by ROI:
  - A: write/edit input pruning (~29K+ tok savings, P0)
  - B: hook output dedup (~12K tok, P1)
  - C: todowrite state dedup (~15K tok, P1)
  - D: status check dedup (~5-10K tok, P2)
  - E: acp-inspect --tool-analysis mode (tooling, P2)
- Defined implementation plan (3 phases), testing strategy, backward compat approach
- Listed 4 open questions for discussion

### Decisions

- This PR is **proposal only** — no code changes to `lib/`. Implementation follows in separate PRs.
- All solutions are **opt-in** via config (default `enabled: false`) until validated.
- Solution E (acp-inspect analysis mode) included because the current `--breakdown`/`--stats` modes lack per-tool-type granularity needed for this kind of diagnosis.
