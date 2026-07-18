# DESIGN - Decompress Tool Range Mode

- Task ID: `2026-07-07_decompress-range-mode`
- Home Repo: `opencode-acp`
- Created: 2026-07-07
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?**: `decompress` is single-block only. The model must call `acp_status` then loop `decompress` per block — wasteful and error-prone.
- **Why now?**: Issue #13 discussion surfaced this; split out as issue #14 so the prompt rewrite (#72) can land independently.

## 2. Goals & Non-Goals

- **Goals**:
  - Add `startId`/`endId` as an alternative to `blockId` on `decompress`
  - Batch-restore all active blocks overlapping the resolved message range
  - Reuse existing boundary resolution (`compress/search.ts`) — no new resolution code
  - Keep `blockId` path byte-for-byte identical (backward compat)
- **Non-Goals**:
  - Partial block restore (impossible by design — a block is atomic)
  - Changing persisted state shape
  - Prompt changes

## 3. Current Architecture (if applicable)

- **How it works today**: `decompress({ blockId: "b0" })` → `parseBlockIdArg` → `resolveCompressionTarget` → active/ancestor checks → `deactivateCompressionTarget` → sync → report. Single target per call.
- **Pain points**: One call per block; model must enumerate blocks first.

## 4. Proposed Architecture

- **Overview**: Handler dispatches by arg shape. Shared tail (deactivate loop + report) handles N targets uniformly.
- **Key components**:
  - `resolveTargets(args, state, rawMessages, logger)` → `{ ok, targets } | { ok: false, error }`
    - `resolveSingleBlockTarget` — existing logic, unchanged behavior
    - `resolveRangeTarget` — new: `buildSearchContext` → `resolveBoundaryIds` → `resolveSelection` → `findActiveBlocksOverlappingMessages` → `resolveCompressionTarget` per block (dedupe by `displayId`)
  - `findActiveBlocksOverlappingMessages(state, messageIdSet)` — new pure function in `decompress-logic.ts`
- **Data flow**:
  ```
  args ─► resolveTargets ─► CompressionTarget[]
                              │
                              ├─ toFile? ─► gather effectiveMessageIds ─► write ─► return
                              │
                              └─ snapshot before ─► deactivate each ─► sync ─► compute deltas ─► report
  ```
- **API / interface changes**:
  - Schema: `blockId?`, `startId?`, `endId?`, `toFile?` (was: `blockId`, `toFile?`)
  - `blockId` XOR (`startId` AND `endId`) enforced at handler level

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Where to resolve range | New resolver in decompress-logic.ts | Reuse `compress/search.ts` | Hardened (Bug 34 auto-swap, clamping, recovery hints); avoids drift |
| Partial overlap policy | Slice block / restore whole | Restore whole | Blocks are atomic units; partial restore is incoherent |
| Nested block handling | Walk parent chain in range mode | Rely on `effectiveMessageIds` superset | Child's effective IDs ⊇ consumed ancestor's effective IDs, so ancestor always matched when child is — no separate walk needed |
| Mutual exclusivity | Allow mix (blockId wins) | Reject with error | Ambiguous intent; clear error is better UX |
| Dedup targets | By blockId | By `displayId` (via `resolveCompressionTarget`) | Message-mode groups multiple blocks under one target; dedupe at target level |

### Nested-block correctness proof

When a child block compresses content that includes an ancestor block's summary:
- `child.effectiveMessageIds` ⊇ `ancestor.effectiveMessageIds` (child consumed the ancestor)
- If the range overlaps any child effective message, and ancestor effective messages are a subset, the range may or may not overlap ancestor's messages directly — BUT `resolveSelection` walks the visible range, and the ancestor's summary placeholder lives at the ancestor's `anchorMessageId`, which is also in the child's effective set. So both get matched. Range mode then calls `deactivateCompressionTarget` on both, which handles the chain correctly (existing Bug 10 fix marks consumed blocks).

## 6. Impact Analysis

- **Backward compatibility**: Fully preserved. `blockId` path is untouched. New fields are optional.
- **Performance**: O(blocks × effectiveIds) for range scan — trivial for typical block counts (<50).
- **Security**: No new I/O, no new permissions. `toFile` path validation unchanged.
- **Dependencies**: None new.

## 7. Migration Plan (if applicable)

- **Steps**: None — schema is additive.
- **Feature flags / gradual rollout**: None needed.

## 8. Open Questions

- [ ] Should range mode automatically skip already-inactive blocks in the report? (Current: yes — only active blocks counted in restored total.)
