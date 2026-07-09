# REQ: Protected Tool Accumulation — Analysis & Solutions Proposal

## Background

Empirical analysis of a long-running ACP session revealed that protected tool calls (`write`, `edit`, `todowrite`) accumulate indefinitely in visible context. While ACP's compression is highly effective at removing large tool outputs (81% of tool chars compressed away), small protected calls between compressed ranges are never swept up.

## Problem

Protected tools (Bug 39 fix) are hard-excluded from compression ranges and their content is soft-injected into summaries when they fall inside a compressed range. However, protected calls that are **never inside a compressed range** stay in full visible context forever.

Over a long session (~574 messages), this accumulation consumed ~58K tok across ~300 visible small tool calls — with `write` alone contributing 51K tok (29K of which is file content duplicated on disk, 12K of which is repeated hook warning output).

## Requirements

1. **Analysis document**: Sanitized empirical analysis of the accumulation pattern (no local paths, no session IDs, no project-specific content).
2. **Proposed solutions**: Ranked by ROI, with estimated savings, risk, and implementation effort.
3. **No implementation yet**: This is a proposal PR — design only. Implementation will follow in separate PRs per solution.

## Deliverables

- [x] `DESIGN.md` — full analysis + 5 proposed solutions (A–E) with priority matrix
- [x] `REQ.md` — this file
- [x] `WORKLOG.md` — work log

## Non-Goals

- Changing the protected-tools mechanism itself (Bug 39 is correct)
- Auto-compressing without model involvement
- Touching the compression prompt format
