# WORKLOG - Decompress Tool Range Mode

- Task ID: `2026-07-07_decompress-range-mode`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-07 23:50

## 1. Summary

- **What was done**: Added optional `startId`/`endId` params to the `decompress` tool schema. Range mode resolves the message range via existing `compress/search.ts` boundary resolution, finds all active blocks whose `effectiveMessageIds` overlap, and batch-decompresses them in one call.
- **Why**: Eliminates the acp_status → decompress-per-block loop the model had to perform. One call restores a range.
- **Behavior / compatibility changes**: Yes — schema additive. `blockId` path unchanged. `blockId` and `startId`/`endId` are mutually exclusive (handler rejects mixes with a clear error).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | feat: decompress range mode (startId/endId) — issue #14 |

### Key Files

- `lib/compress/decompress.ts` — schema gains optional `startId`/`endId`; handler refactored into `resolveTargets` dispatcher → `resolveSingleBlockTarget` (unchanged logic) | `resolveRangeTarget` (new). Shared tail: `toFile` gather across all active blocks, deactivate loop, report with pluralization.
- `lib/compress/decompress-logic.ts` — new exported `findActiveBlocksOverlappingMessages(messagesState, messageIdSet)`. Pure, O(blocks × effectiveIds), dedupes via Map, returns sorted by blockId.
- `tests/decompress-logic.test.ts` — 11 new tests for `findActiveBlocksOverlappingMessages` (empty set, no blocks, match, inactive skip, partial overlap, multi-block sort, dedupe, disjoint, undefined effectiveIds, nested child-only, nested ancestor+child).
- `devlog/2026-07-07_decompress-range-mode/` — REQ.md, DESIGN.md, WORKLOG.md.

## 3. Design & Implementation Notes

- **Entry point / key function**: `resolveTargets` in `decompress.ts` — dispatches by arg shape, returns `{ok, targets} | {ok: false, error}`.
- **Key configuration items**: None new.
- **Key logic explanation**:
  - Range resolution reuses `buildSearchContext` → `resolveBoundaryIds` (auto-swaps reversed boundaries, clamps OOB refs — Bug 34 + clamping fix) → `resolveSelection` (walks visible range, collects `messageIds`).
  - `findActiveBlocksOverlappingMessages` scans `blocksById`, keeps active blocks where any effective message is in the selection set.
  - Nested correctness: child's `effectiveMessageIds` ⊇ consumed ancestor's, so if child overlaps, ancestor is also matched — no separate parent-chain walk needed in range mode.
  - Mutual exclusivity (`blockId` XOR `startId`+`endId`) enforced at handler entry with clear errors.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Type check
npx tsc --noEmit                              # PASS

# Run targeted test file
bun test tests/decompress-logic.test.ts       # 47 pass, 0 fail

# Run full suite
bun test tests/                               # 586 pass, 1 fail (pre-existing, unrelated)

# Build
npm run build                                 # PASS (dist/index.js 357 KB)
```

### Test Coverage

- New/modified test files: `tests/decompress-logic.test.ts`
- Test count: 587 total, 586 pass, 1 fail
- Key scenarios verified:
  - Empty message set → `[]`
  - Active block overlap → matched
  - Inactive block → skipped
  - Partial overlap → whole block matched
  - Multiple blocks → sorted by blockId, deduped
  - Nested child-only overlap
  - Nested ancestor + child both matched

### Results

- **PASS** (the 1 failure is `prompts.test.ts:53` — Bun does not implement `test() inside test()`; verified pre-existing on master via `git stash && bun test && git stash pop`).

## 5. Risk Assessment & Rollback

- **Risk points**: Low. Schema addition is backward compatible; `blockId` path is byte-identical to before.
- **Rollback method**:
  - Revert commit on branch `2026-07-07_decompress-range-mode`.
- **Compatibility notes**: No persisted-state changes. No config schema changes.

## 6. Lessons Learned (optional)

- Reusing `compress/search.ts` for boundary resolution was the key insight — the hardened Bug 34 (auto-swap reversed boundaries) and OOB clamping come for free.
- Bun's `node:test` shim does not support nested `test()` calls — affects `prompts.test.ts` only; not a regression.

## 7. Follow-ups (optional)

- [ ] Dual-agent code review (per AGENTS.md §5.3) before merge
- [ ] Consider a follow-up to surface matched block IDs in the range-mode error when zero overlap (point to `acp_status`)
