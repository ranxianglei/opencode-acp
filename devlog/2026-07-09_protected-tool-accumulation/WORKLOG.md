# WORKLOG: Batch Sweep Compression + Age-Based Protection

## 2026-07-09 (v1 — Initial Proposal)

### Analysis Phase

- Queried session database directly (SQLite + JSON parsing) to analyze ~500 tool calls across a long session
- Categorized visible small tool calls (<0.5K tok each) by tool type: bash, todowrite, write, edit, read
- Deep-dived `write` tool: discovered 51K tok is NOT "all success echoes" but split into ~29K file content (input) + ~12K hook output + ~4K markdown + misc
- Spot-checked 5 compression blocks for quality control: all rated Good–Excellent
- Identified root cause: protected tools accumulate because they're never inside compressed ranges

### v1 Design (REJECTED)

- Proposed 5 silent pre-pruning solutions (A–D) + acp-inspect tooling (E)
- Solutions A–D proposed stripping content without model involvement
- **Maintainer @dog rejected this approach**: tools may contain important info; model must decide what to keep

## 2026-07-09 (v2 — Confirmed Design)

### Multi-Session Analysis (5 sessions)

- Ran `acp-inspect --tool-analysis` on 5 sessions (331–1638 msgs)
- **bash duplication confirmed**: `export CI=true...` prefix repeated 11–30× per session (env injection); SSH commands repeated 30× in one session
- **todowrite fragmentation confirmed**: 0% pruned in most sessions; spread across 70%+ of session; avg gap 5–7 msgs
- **Cache invalidation impact measured**: one session had 70 compressions, 71% covering <5 messages = ~50 cache breaks

### Root Cause Investigation

- Traced todowrite compression failure to `lib/compress/range.ts:99` → `filterProtectedToolMessages()`
- `lib/compress/protected-content.ts:233`: unconditionally removes protected tool messages from compression selection
- Bug 39 protection is **ageless** — old and recent protected tools treated identically

### acp-inspect --tool-analysis (Solution E — COMPLETED ✅)

- Implemented `cmd_tool_analysis()` in `~/.local/bin/acp-inspect` (+200 lines)
- 6 output sections: per-tool-type summary, size brackets, redundancy detection, input/output split, top-10 largest, protected accumulation
- Updated `~/.claude/skills/acp-inspect/SKILL.md` with new workflow documentation
- Tested on 4 sessions (36–1638 msgs), all pass

### v2 Design (CONFIRMED by @dog)

- **Feature A (PR-A)**: Age-based protection — `protectedToolMaxAge` config; old todowrite becomes compressible
- **Feature B (PR-B)**: Batch sweep compression — per-tool-type accumulation tracker; dual threshold (5% + quantitative); cache-friendly range recommendations (recent→old); deferred delivery
- Key design decisions confirmed by maintainer:
  1. Per-tool-type 5% threshold + quantitative threshold (AND)
  2. Range recommendation: recent → old (cache-friendly)
  3. Contiguous ranges, merge gap <3
  4. Model transcribes important info to summary
  5. Fragmentation detection for all tool types
  6. todowrite: near-term protection only, not far-term

### Decisions

- v1 Solutions A–D (silent pre-pruning) **rejected** — model must decide what to keep
- v2 approach preserves model agency: ACP provides better triggers and range suggestions, model still writes summaries
- PR-A (age protection) ships first — small, low-risk, unlocks todowrite compressibility
- PR-B (batch sweep) depends on PR-A
