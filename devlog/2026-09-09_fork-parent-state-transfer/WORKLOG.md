# WORKLOG - Recover compression blocks from parent state when forks omit historical compress inputs

- Task ID: `2026-09-09_fork-parent-state-transfer`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-09 20:30

## 1. Summary

- **What was done** (1–3 sentences): Added a parent-state transfer path for fork initialization. When a fork (session with `parentID`) has no fork-local state file, ACP now loads the parent's ACP state, maps the parent's message IDs to the fork's message IDs across the copied shared prefix, translates the parent's compression blocks onto the fork's IDs, and saves independent fork-local state. Falls back to the existing historical replay when the transfer is not possible.
- **Why** (1–3 sentences): Forks strip `compress` tool `state.input`, so replay-only reconstruction yields zero blocks and the copied raw parent history overflows the fork's context. Translating the parent's already-built blocks recovers the compression without depending on `state.input` surviving the copy.
- **Behavior / compatibility changes**: Yes — additive. New recovery path for forks with a `parentID`; existing replay is preserved as the fallback. No persisted-format change. Does not mutate the parent; does not inherit nudge cadence.
- **Risk level**: Medium (new async path touching fork init; mitigated by strict fallback to the existing replay on any failure).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `b389f61` | feat: recover fork compression blocks from parent state when historical compress inputs are stripped |
| `5ba7484` | merge: resolve conflict with master (storagePath warning + fork parent-state transfer) |

### Conflict resolution (2026-09-09)

Merged master (`5135dfd`, incl. #380 storagePath) into the PR branch. Single conflict in
`lib/state/state.ts` `ensureSessionInitialized()`: this PR's fork-recovery comment block
overlapped the new storagePath default-location warning. Resolution keeps both — the
storagePath warning runs first, then the fork recovery path (parent-state transfer →
historical replay fallback). No behavior change on either side. Verified after merge:
`npm run typecheck` clean, `npm run build` success, `npm run test` → 1138 pass / 0 fail.

### Key Files

- `lib/state/fork-transfer.ts` (new) — `recoverFromParentState()` and its helpers (`buildSharedPrefixMapping`, `translateBlock`, `remapBoundaryRef`, `translateByMessageId`, `extractIdentity`).
- `lib/state/state.ts` — fork init path: resolve `parentId` via `getForkParentId`, try `recoverFromParentState` first, fall back to `rebuildCompressionState`, save if >0.
- `lib/state/utils.ts` — new `getForkParentId()`; `isSubAgentSession` refactored to reuse it (same boolean result).
- `tests/rebuild-parent.test.ts` (new) — 7 unit tests.

## 3. Design & Implementation Notes

- **Entry point / key function**: `recoverFromParentState(client, state, forkMessages, parentId, logger): Promise<number>` in `lib/state/fork-transfer.ts`.
- **Key logic explanation** (non-trivial):
  - **Mapping**: `buildSharedPrefixMapping` reduces both the parent and fork message lists to `{ id, role, time.created }` identities (skipping synthetic `msg_dcp_*` / `msg_acp_*` messages and empty IDs) and matches them by **position + `time.created` + role**, stopping at the first mismatch. This is deliberately **not** ref-based: forks carry `parentID`, so `isSubAgent` is true and `assignMessageRefs` skips the fork's first user message, shifting the fork's `mNNNNN` refs by one relative to the parent. Matching on `time.created`/`role` (preserved by the fork copy) is robust to that shift.
  - **Translation**: each parent block's `directMessageIds` / `effectiveMessageIds` / `directToolIds` / `effectiveToolIds` / `anchorMessageId` / `compressMessageId` are remapped through the mapping; `startId`/`endId` message refs are remapped via `parentByRef → parentRaw → mapping → forkRaw → forkByRawId → forkRef`, while `bN` block refs are preserved (block IDs are kept, so nested lineage stays valid). Blocks whose `anchorMessageId` or `compressMessageId` falls outside the shared prefix are skipped (partial forks / parent continued after fork).
  - **State assembly**: translated blocks + translated `byMessageId` are passed to `loadPruneMessagesState`, which rebuilds `activeBlockIds` / `activeByAnchorMessageId` / `nextBlockId` / `nextRunId` exactly as when the parent's own state is loaded. Nudge and current-turn state are intentionally not copied.
  - **Tool ids**: `directToolIds` / `effectiveToolIds` hold tool **call** ids (`part.callID`), which are preserved verbatim across a fork copy. They are copied as-is (deduped), NOT run through the message-id mapping — doing so would drop every entry (call ids never equal message ids).
  - **Active-only transfer**: `state.prune.messages` is assigned only when at least one **active** block is translatable. If only inactive blocks survive the translation (e.g. the parent continued after the fork), the fork state is left untouched and the caller falls back to replay — otherwise replay would run on top of already-transferred inactive blocks.
  - **Boundary refs (best-effort)**: `startId`/`endId` are remapped through the raw-id mapping. When the boundary message's fork raw id has no ref (only the fork's first user message, skipped under the sub-agent classification), the original parent ref is kept. This is metadata only (dedup key, GC-merge boundary, display); core pruning is `byMessageId`-based and unaffected.
  - **Fallback**: returns 0 (→ caller runs `rebuildCompressionState`) when the parent state is missing, the parent has no blocks, the parent message fetch fails, the shared prefix is empty, no block is translatable, or no **active** block is translatable.

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp && npm run build
node --import tsx --test tests/*.test.ts
node --import tsx --test tests/rebuild-parent.test.ts
npx tsc --noEmit
```

### Test Coverage

- New/modified test files: `tests/rebuild-parent.test.ts` (new, 7 tests).
- Test count: 1084 total, 1084 pass, 0 fail (was 1077 before this change).
- Key scenarios verified:
  - Recovery when `state.input` is stripped (the #375 case): 1 block recovered, `anchorMessageId`/`compressMessageId`/`effectiveMessageIds`/`byMessageId` all remapped to fork raw IDs; the compress message is not pruned. Also asserts `startId`/`endId` remap, summary text is preserved, and a tool call id (`tool-1`) survives the transfer.
  - Ref-shift robustness: with `isSubAgent=true` (fork's first user message skipped, refs shifted), the same correct raw-ID mapping is produced; `endId` remaps correctly and the best-effort `startId` fallback is pinned.
  - Fallbacks: no parent state → 0; no shared prefix (sub-agent messages) → 0; parent has no blocks → 0.
  - Independence: fork does not inherit parent nudge tokens; parent state file is not mutated (reloaded: 1 block, nudge token preserved).
  - Out-of-prefix skip: parent with two blocks (one anchored inside the copied prefix, one anchored after it) → only the in-prefix block is transferred; the out-of-prefix block is skipped.

### Results

- **PASS/FAIL**: PASS.
- **Key logs/data**: `npm run typecheck` clean; `npm run build` → `dist/index.js` 431.73 KB; `npm run test` → `# pass 1084 / # fail 0`.

## 5. Risk Assessment & Rollback

- **Risk points**: mapping correctness if a fork copy reorders or drops messages (mitigated by the hard stop at the first position/`time.created`/role mismatch); one extra parent message fetch per fork init.
- **Rollback method**:
  - Revert commit(s): `<sha>`
  - Rollback impact: forks revert to replay-only reconstruction (the pre-change behavior). No data migration.
- **Compatibility notes** (data format, config schema): No — persisted state format and config are unchanged.

## 6. Lessons Learned (optional)

- What went well: reusing `loadPruneMessagesState` to rebuild active sets kept the translation consistent with how the parent's own state is loaded.
- What could be improved: the ref shift caused by classifying forks as sub-agents is a latent issue that also affects the existing replay path's ref resolution — see DESIGN §8.
- Reusable conclusions: match fork↔parent messages on `time.created`/`role`/position, never on `mNNNNN` refs.

## 7. Follow-ups (optional)

- [ ] Consider whether forks should stop being classified as sub-agents (removes the ref shift at the root; also fixes the existing replay path's ref resolution).
