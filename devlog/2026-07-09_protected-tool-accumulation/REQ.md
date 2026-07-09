# REQ: Batch Sweep Compression + Age-Based Protection

## Background

Empirical analysis of 5 long-running ACP sessions (331–1638 messages each) revealed two problems:

1. **Protected tool accumulation**: `todowrite`, `write`, `edit` calls between compressed ranges are never swept, consuming 18–51% of visible tool tokens with largely redundant content.
2. **Cache fragmentation**: The model does many small range compressions (71% covering <5 messages in one session), each invalidating the prefix cache.

## Problem

### Protected tools can't be compressed
`filterProtectedToolMessages` (`lib/compress/protected-content.ts:233`) unconditionally removes protected tool messages from compression selections. A todowrite from 2 messages ago and one from 200 messages ago are treated identically — both permanently protected.

### Small compressions break cache
Each compression changes the message array, invalidating the prefix cache at the compression boundary. 70 small compressions = 70 cache breaks.

## Requirements (confirmed by maintainer @dog)

1. **Per-tool-type tracking**: Track accumulation per tool type (bash, todowrite, write, etc.)
2. **Dual threshold trigger**: Fire when a tool type hits 5% of context AND quantitative threshold (AND logic)
3. **Cache-friendly ranges**: Recommend ranges from recent → old (newest first preserves prefix cache)
4. **Contiguous ranges**: Merge adjacent segments (gap <3 msgs) to reduce model merge pressure
5. **Model transcribes**: Nudge must warn that tools may contain important info — model must transcribe to summary
6. **Fragmentation detection**: Detect fragmentation degree for ALL tool types (span %, avg gap)
7. **Age-based protection**: todowrite should have near-term protection only; old todowrite calls should be compressible
8. **Deferred delivery**: Don't interrupt the model mid-task; allow nudge to be slightly delayed

## Deliverables

- [x] `DESIGN.md` — confirmed v2 design (batch sweep + age protection)
- [x] `REQ.md` — this file
- [x] `WORKLOG.md` — work log
- [x] `acp-inspect --tool-analysis` mode — implemented and tested (Solution E from v1)

## Implementation (follow-up PRs)

- **PR-A**: Age-based protection (`protectedToolMaxAge` config + `filterProtectedToolMessages` change)
- **PR-B**: Batch sweep compression (accumulation tracker + trigger + range computation + nudge)

## Non-Goals

- Silent content stripping without model involvement (v1 Solutions A–D — **rejected**)
- Changing the compress tool API
- Touching the compression prompt format
