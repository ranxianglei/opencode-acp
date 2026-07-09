# Proposal: Protected Tool Accumulation — Analysis & Solutions

> **Status**: Proposal (analysis + design only, no implementation yet)
> **Date**: 2026-07-09
> **Motivation**: Empirical analysis of a long-running session revealed that protected tool calls (`write`, `edit`, `todowrite`) accumulate indefinitely in visible context, consuming 40–60% of the tool-category token budget with content that is largely redundant after consumption.

---

## 1. Problem Statement

ACP's protected-tools mechanism (Bug 39 fix) ensures that calls to `write`, `edit`, `todowrite`, `task`, `skill`, and similar tools are **hard-excluded from compression ranges** and their content is **soft-appended to summaries** when they fall inside a compressed range.

This design correctly **prevents content loss** — but it has an unintended consequence: **protected tool calls that are never inside a compressed range accumulate forever in visible context.**

The model compresses large outputs aggressively (delegate_task results, build logs, file reads) but rarely sweeps up the scattered small protected calls between them. Over a long session, these pile up.

### 1.1 The Accumulation Pattern

```
Session timeline:
  [big output] [small write] [small edit] [small todo] [big output] [small write] ...
       ↓                                                        ↓
   compressed                                              compressed
       ↓                                                        ↓
   summary block                                        summary block

  What remains visible:
  [summary] [small write] [small edit] [small todo] [summary] [small write] ...
              ↑              ↑              ↑                     ↑
         never swept      never swept   never swept           never swept
```

The small protected calls between compressed ranges are never captured into any block, so their content stays in full visible context for the entire session.

---

## 2. Empirical Analysis

### 2.1 Methodology

Analyzed one long-running session (~574 messages, ~500 tool calls, 60 active compression blocks) using direct SQLite queries against the session database. Token estimates use chars/4 heuristic (cross-validated against API-reported token counts; ±15% accuracy).

**All data below is sanitized**: no file paths, no session IDs, no project-specific content. Only structural patterns are reported.

### 2.2 Overall Compression Effectiveness

| Metric | Value |
|--------|-------|
| Total tool calls | ~500 |
| Compressed (pruned) | ~200 (40%) |
| Still visible | ~300 (60%) |
| Compressed tokens | ~286K tok |
| Summary tokens | ~67K tok |
| **Compression savings** | **81% of tool chars compressed away** |

**Verdict**: ACP's compression is highly effective at removing large tool outputs. The problem is specifically with the **small protected calls that survive**.

### 2.3 Visible Small Tool Calls (<0.5K tok each)

~300 visible tool calls under 0.5K tokens each, totaling ~58K tok. Breakdown by type:

| Tool | Calls | Total tok | Avg tok | Primary content |
|------|-------|-----------|---------|-----------------|
| `bash` | ~114 | ~21K | 186 | Repeated status checks (`tmux ls`, GPU monitoring, log reads) |
| `todowrite` | ~73 | ~18K | 243 | Full todo list snapshots; old states are pure history |
| `write` | ~38 | ~51K | — | See §2.4 (dominated by file content + hook echoes) |
| `edit` | ~48 | ~18K | — | "Edit applied successfully." × 48 |
| `read` | ~46 | ~8K | 177 | Directory listings, short file reads |

### 2.4 The `write` Deep Dive (Largest Single Contributor)

The `write` tool's 51K tok is NOT "all success echoes." Breakdown:

| Component | tok | Description |
|-----------|-----|-------------|
| **File content (input)** | **~29K** | Full source code of files written to disk (.py scripts, .md docs, .yaml configs) |
| **Hook output** | **~12K** | A project-level git hook ("comment/docstring detected") fired 16×, each producing 2.5–5.6K chars of identical warning text |
| Markdown content | ~4K | DESIGN.md, WORKLOG.md, analysis docs |
| YAML configs | <1K | .meta.yaml files |
| "Wrote file successfully." | <1K | Actual success echo |

**Key insight**: 29K tok of `write` input is **file content that already exists on disk**. It is functionally equivalent to a `read` of that file — except `read` output can be compressed, while `write` input cannot (it's protected).

### 2.5 Compression Quality Spot-Check (Control)

To verify that the compression itself is working well, sampled 5 active blocks across the session timeline:

| Block | Compressed tok | Summary tok | Ratio | Quality |
|-------|---------------|-------------|-------|---------|
| b1 | 18.9K | 2.0K | 9.6× | Excellent — preserved file paths with line numbers, critical code lines, exact PPL values, decisions with rationale |
| b20 | 28.7K | 1.0K | 27.9× | Excellent — design formulas, user directives verbatim, training configs |
| b38 | 1.6K | 0.15K | 10.7× | Good — concise checkpoint status |
| b54 | 3.7K | 0.08K | 48.6× | Adequate — minimal but sufficient |
| b68 | 1.1K | 0.10K | 11.4× | Good — reply summary |

**Conclusion**: Compression quality is high. The problem is NOT compression quality — it's that protected tools are never **reached** by compression.

---

## 3. Root Cause Analysis

### 3.1 Protection vs. Accumulation

The protected-tools mechanism has two effects:

1. **Hard exclusion** (Bug 39): Protected tool messages are excluded from compression ranges — they survive intact in visible context.
2. **Soft injection**: When a protected tool IS inside a compressed range, its content is appended to the summary.

Effect #1 means protected calls between compressed ranges are **never swept**. Effect #2 only triggers when the model explicitly compresses a range containing them.

### 3.2 Why the Model Doesn't Sweep Them

The compression philosophy instructs the model to "target one large consumed range per compress call." The model correctly identifies large outputs (delegate_task 12K, background_output 10.9K) and compresses those. But:

- Small protected calls are scattered individually between big outputs.
- Compressing them requires a "sweep" compress call covering many small messages.
- The model does attempt this ("Consumed tool outputs batch" topics appear in the data), but too infrequently.

### 3.3 The Redundancy Tax

Protected tools carry inherently redundant content:

| Tool | Redundant content | Why redundant |
|------|------------------|---------------|
| `write` | Full file content in input | File exists on disk; `read` can retrieve it |
| `edit` | "Edit applied successfully." | Zero information value after consumption |
| `todowrite` | Full todo list snapshot | Only latest state matters; old states are history |
| `bash` | Repeated status checks | Latest output supersedes earlier ones |

---

## 4. Proposed Solutions

### Solution A: Protected Tool Input Pruning (`write`/`edit`)

**Concept**: After a `write` or `edit` call is N turns old, strip its input content, keeping only `filePath` + output.

**Mechanism**: New strategy module `lib/strategies/strip-written-content.ts`:
- Runs in `prepareSession()` alongside `deduplicate()` and `purgeErrors()`
- For `write`/`edit` calls older than `turns` threshold:
  - Replace `input.content` with `"[content pruned — file exists at {filePath}]"`
  - Keep `input.filePath` and `output` intact
- Config: `strategies.stripWrittenContent: { enabled: true, turns: 4, protectedTools: [] }`

**Estimated savings**: ~29K tok (write input) + ~18K tok (edit — if input contains large oldString/newString)

**Risk**: LOW. The file exists on disk. If the model needs the content, it can `read` it (and that `read` CAN be compressed normally). The only loss is the "what did I write at this point in history" audit trail — which is low-value for most workflows.

**Edge cases**:
- Write followed by delete: content is gone from disk. Mitigation: only prune if file still exists (check via `fs.existsSync`).
- Write that failed: keep full content for debugging. Mitigation: only prune successful writes.

### Solution B: Hook Output Deduplication

**Concept**: Detect repeated identical/similar tool outputs and keep only the latest K instances.

**Mechanism**: Extend `lib/strategies/deduplication.ts`:
- Current dedup: same tool + same args → prune all but last
- **New**: same tool + output prefix matches pattern → prune all but last K
- Config: `strategies.deduplication: { outputPrefixMatch: { enabled: true, prefixLength: 100, keep: 2 } }`

**Estimated savings**: ~12K tok (the 16 repeated hook warnings → keep 2)

**Risk**: LOW. If the hook output changed meaningfully between calls, the prefix match won't trigger. Only exact-prefix duplicates are pruned.

### Solution C: TodoWrite State Dedup

**Concept**: Keep only the latest K `todowrite` calls visible; prune older snapshots.

**Mechanism**: New strategy `lib/strategies/todo-dedup.ts`:
- Track all `todowrite` calls in session
- Keep latest `keep` calls (default: 3) fully visible
- For older calls: replace full todo list with a one-line status summary: `"[{N} todos: {completed}/{total} completed, pruned — see latest todowrite]"`

**Estimated savings**: ~15K tok (73 calls → 3 visible)

**Risk**: MEDIUM. Todo history can be useful for understanding task progression. Mitigation: the summary line preserves the completion ratio; the latest 3 calls preserve recent context. If full history is needed, the user can scroll up in the UI.

**Note**: `todowrite` is environment-managed (its output is auto-preserved during compression). This strategy operates at the **message-transform** level (before compression), pruning old calls from visible context. It does NOT interfere with the compression-protection mechanism.

### Solution D: Status Check Dedup (`bash`)

**Concept**: For repeated `bash` status commands (same command, different output over time), keep only the latest output.

**Mechanism**: Extend `lib/strategies/deduplication.ts`:
- **New mode**: `sameCommandKeepLatest` — for bash commands matching configurable patterns (e.g., `nvidia-smi`, `tmux ls`, `git status`), keep only the latest output.
- Config: `strategies.deduplication: { statusCommands: { enabled: true, patterns: ["nvidia-smi", "tmux ls", "git status"], keep: 1 } }`

**Estimated savings**: ~5–10K tok

**Risk**: LOW. Status checks are inherently supersedeable. The latest GPU utilization replaces all previous checks.

### Solution E: acp-inspect `--tool-analysis` Mode

**Concept**: Add a new analysis mode to the `acp-inspect` diagnostic tool that provides the per-tool-call granularity used in this analysis.

**Features**:
- Break down visible tool calls by tool type (bash/write/todowrite/edit/...)
- Split input vs output tokens per call
- Detect redundancy patterns (repeated commands, repeated outputs)
- Sample tool calls per category for manual inspection
- Show temporal distribution (which quartile of the session are small tools concentrated in?)

**Rationale**: The current `--breakdown` mode only categorizes messages as tool/code/text/summary at the aggregate level. The `--stats` mode shows cumulative traffic. Neither provides the per-tool-type, per-call granularity needed to diagnose accumulation issues.

**Estimated effort**: Medium (1–2 hours). The acp-inspect script already loads messages and ACP state; this adds categorization + reporting logic.

---

## 5. Solution Priority Matrix

| Solution | Est. savings | Risk | Effort | Priority |
|----------|-------------|------|--------|----------|
| **A: Write/edit input pruning** | ~29K+ tok | LOW | Medium | **P0** — biggest single win |
| **B: Hook output dedup** | ~12K tok | LOW | Low | **P1** — easy, high ROI |
| **C: TodoWrite dedup** | ~15K tok | MEDIUM | Low | **P1** — high ROI, needs config tuning |
| **D: Status check dedup** | ~5–10K tok | LOW | Low | **P2** — incremental |
| **E: acp-inspect analysis** | 0 (tooling) | NONE | Medium | **P2** — enables future diagnosis |

**Total estimated savings**: ~60–75K tok per long session (if A+B+C+D all implemented).

---

## 6. Implementation Plan

### Phase 1: Analysis & Config Foundation (this PR)

- [x] This design document (analysis + proposed solutions)
- [ ] Add config schema for new strategies (no logic yet)
- [ ] Add `acp-inspect --tool-analysis` mode (Solution E)

### Phase 2: High-ROI Strategies (follow-up PRs)

- [ ] Solution B (hook output dedup) — lowest risk, extends existing dedup module
- [ ] Solution C (todowrite dedup) — new module, well-isolated
- [ ] Solution A (write/edit input pruning) — biggest win, needs careful edge-case handling

### Phase 3: Incremental (follow-up PRs)

- [ ] Solution D (status check dedup) — extends dedup with pattern matching

### Testing Strategy

Each strategy module gets its own test file (`tests/strategies-*.test.ts`) following the existing pattern. Tests use mock message arrays and verify:
1. Correct calls are pruned (age threshold, pattern match)
2. Protected calls survive (configurable `protectedTools`)
3. Edge cases (file deleted, write failed, empty todo list)

### Backward Compatibility

- All strategies are **opt-in** via config (default: `enabled: false` for new strategies until validated).
- Existing config without the new keys continues to work (defaults applied).
- No changes to persisted state format (strategies operate at message-transform time, before persistence).

---

## 7. Open Questions

1. **Should write/edit input pruning be a "strategy" or a core message-transform step?** Strategies run in `prepareSession()` (only when `compress` tool is called). Core transform runs every LLM call. If we want continuous pruning, it should be in the transform pipeline. If we want it only at compression time, strategy is correct.

2. **Should todowrite dedup respect `turnProtection`?** If `turnProtection` is enabled and a todowrite is within the protection window, should it be exempt from dedup?

3. **Config granularity**: Should the dedup patterns (Solution D) be user-configurable per-project, or ship sensible defaults? Project-specific commands (e.g., `kubectl get pods`) would benefit from customization.

4. **Should write/input pruning interact with `decompress`?** If we prune a write's input, should `decompress` be able to restore it from the database? (The raw message is still in the DB; we're only modifying the transformed view sent to the LLM.)

---

## 8. Non-Goals

- **Changing the protected-tools mechanism itself.** Bug 39's hard-exclusion is correct — protected tools should survive intact when inside a compressed range. This proposal adds **pre-compression pruning** for redundant content, not changes to the protection logic.
- **Auto-compressing without model involvement.** All solutions operate at the message-transform level (pruning redundant content from what the model sees), not at the compression level (creating summary blocks). The model still decides when to compress.
- **Touching the compression prompt.** The compression philosophy and format guidance are separate concerns.
