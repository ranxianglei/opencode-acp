# DESIGN - Recover compression blocks from parent state when forks omit historical compress inputs

- Task ID: `2026-09-09_fork-parent-state-transfer`
- Home Repo: `opencode-acp`
- Created: 2026-09-09
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** A fork reconstructs its prune state only by replaying completed `compress` tool parts that still carry `state.input`. When the fork copy strips those inputs, no blocks are rebuilt and the copied raw parent history becomes visible, blowing up token usage.
- **Why now?** A production fork hit 20,581+ messages / 925K tokens against a 400K limit with `no_executable_candidates` and no `rebuild: reconstructed` event (issue #375).

## 2. Goals & Non-Goals

- **Goals**:
  - Recover the parent's compression blocks into a fork that has a `parentID` and no fork-local state.
  - Translate block message coverage from parent raw IDs to fork raw IDs across the copied shared prefix.
  - Save independent fork-local state without inheriting nudge cadence / current-turn state and without mutating the parent.
  - Fall back to the existing historical replay when parent transfer is not possible.
- **Non-Goals**:
  - Changing the `isSubAgent` classification of forks (we are robust to the resulting ref shift, but do not alter it).
  - A shared/cross-session block store.

## 3. Current Architecture

- `ensureSessionInitialized` (lib/state/state.ts) loads the fork's state file; when absent it calls `rebuildCompressionState` (lib/state/rebuild.ts), which replays completed `compress` parts with an object `state.input` and rebuilds blocks from the recorded `startId`/`endId` refs.
- **Pain point**: replay depends entirely on `state.input` surviving the fork copy. Stripped inputs → 0 blocks.

## 4. Proposed Architecture

- **Overview**:

```
ensureSessionInitialized (fork, no local state)
  │
  ├─ getForkParentId(client, sessionId) -> parentId | null
  │
  ├─ if parentId:
  │     recoverFromParentState(client, state, forkMessages, parentId, logger)
  │        1. loadSessionState(parentId)          -> parent state (or null)
  │        2. parent blocks? (>=1)                -> else 0
  │        3. client.session.messages(parentId)   -> parent messages (or [])
  │        4. buildSharedPrefixMapping(parent, fork)  # position + time.created + role
  │        5. assignMessageRefs(state, fork)      # fork refs (idempotent)
  │        6. translate each parent block (raw IDs + startId/endId refs)
  │        7. state.prune.messages = loadPruneMessagesState(translated)
  │        return activeBlockCount
  │
  ├─ if recovered === 0:
  │     rebuildCompressionState(state, forkMessages, config, logger)   # existing replay
  │
  └─ if recovered > 0: saveSessionState(state)   # fork-local, independent
```

- **Key components**:
  - `recoverFromParentState` (lib/state/fork-transfer.ts) — orchestrates load → map → translate → apply.
  - `buildSharedPrefixMapping` — matches parent/fork message lists by position + `time.created` + `role`, stopping at the first mismatch.
  - `translateBlock` / `remapBoundaryRef` / `translateByMessageId` — remap a block's coverage and refs onto fork IDs.
  - `getForkParentId` (lib/state/utils.ts) — returns the session's `parentID` (string | null).
- **Data flow**: parent state file → in-memory parent blocks → translated fork blocks → fork `prune.messages` → fork state file.
- **API / interface changes**: new exported `recoverFromParentState`; new exported `getForkParentId`; `isSubAgentSession` now delegates to `getForkParentId` (same boolean result). No persisted-format change.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| How to map parent→fork messages | (a) align by ref `mNNNNN`; (b) align by position + `time.created` + role | (b) | Forks have `parentID` ⇒ `isSubAgent` ⇒ `assignMessageRefs` skips the fork's first user message ⇒ fork refs are shifted by one vs the parent. Ref alignment would point blocks at the wrong messages. `time.created`/`role` are preserved by the fork copy; only raw IDs change. |
| Which blocks to transfer | only active; all (active + inactive) | all, then rebuild active sets | Mirrors how the parent's own state is loaded (`loadPruneMessagesState` rebuilds `activeBlockIds`/`activeByAnchorMessageId` from all blocks). Preserves nested/inactive lineage. |
| Blocks whose anchor is outside the shared prefix | fail the whole transfer; skip the block | skip the block | Handles partial forks and parents that continued after the fork; recover what is safely placeable. |
| When to fall back to replay | never; on any failure | on any failure (no parent state / no prefix / no blocks / fetch error / nothing translatable) | Preserves existing behavior as a strict superset. |
| Nudge / current-turn state | copy from parent; do not copy | do not copy | A fork is a fresh session; inheriting cadence would mis-time nudges. |

## 6. Impact Analysis

- **Backward compatibility**: none broken. New code path only triggers when `parentID` is set AND no fork-local state exists AND the fork path previously produced 0 blocks. Persisted format unchanged.
- **Performance**: one extra `client.session.messages(parentId)` call per fork init (rare, one-time). Translation is O(blocks + messages).
- **Security**: no new network targets (same `client`); reads the parent's local state file and its messages via the existing SDK client.
- **Dependencies**: none new.

## 7. Migration Plan

- **Steps**: none. The feature is additive and self-contained.
- **Feature flags / gradual rollout**: none required; behavior is a strict superset of the current replay path.

## 8. Open Questions

- [ ] Should forks stop being classified as sub-agents (which would remove the ref shift at the root)? Out of scope here, but worth a follow-up issue since it also affects the existing replay path's ref resolution.
