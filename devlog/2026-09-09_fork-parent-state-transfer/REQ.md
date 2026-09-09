# REQ - Recover compression blocks from parent state when forks omit historical compress inputs

- Task ID: `2026-09-09_fork-parent-state-transfer`
- Home Repo: `opencode-acp`
- Created: 2026-09-09
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: issue #375 (ranxianglei/opencode-acp)

## 1. Background & Problem Statement

- **Context**: OpenCode forks receive a new session ID and a copied message history. ACP keeps per-session prune state (compression blocks) in `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`. A fork has no fork-local state file, so ACP must reconstruct its prune state.
- **Current behavior (symptom)**: `ensureSessionInitialized` (lib/state/state.ts) reconstructs fork state only by replaying completed historical `compress` tool parts whose `state.input` survives (`rebuildCompressionState` in lib/state/rebuild.ts). When the fork copy omits/strips those inputs, **zero** blocks are rebuilt, the copied raw parent history stays visible, and token usage can jump dramatically (observed: 20,581+ messages, 925,103 tokens vs a 400K limit; repeated `reason=no_executable_candidates`, no `rebuild: reconstructed …` event).
- **Expected behavior**: When a session has a `parentID` and no fork-local state, ACP should recover the parent's compression blocks by translating their message coverage onto the fork's message IDs, so the fork prunes the same shared prefix the parent already compressed.
- **Impact**: Forks of long, already-compressed sessions lose all compression and overflow their context window.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22 / 24 (CI matrix)
  - OS/Arch: linux
- **Minimal reproduction steps**:
  1) Parent session compresses a range (a `compress` tool part with `state.input` exists in the parent, and the parent's ACP state file has ≥1 block).
  2) Fork the session. The fork copies the parent's messages but the `compress` part's `state.input` is stripped/omitted.
  3) On first fork init, `rebuildCompressionState` finds no replayable compress input → 0 blocks → the copied raw history is visible.
- **Relevant configuration**: default.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: must not break existing fork replay (stripped-input case where no parent state exists) or sub-agent behavior. Persisted state format unchanged.
  - Performance: one extra `client.session.messages` fetch per fork init (forks are rare; one-time). Acceptable.
  - Resource limits: none.
  - Must NOT mutate the parent state; must NOT inherit parent nudge cadence / current-turn state.
- **Non-Goals** (explicitly out of scope):
  - Fixing the broader sub-agent/fork `isSubAgent` classification (forks are currently treated as sub-agents, which shifts refs by one). This change is *robust to* that shift but does not change it.
  - Cross-session block sharing / a shared block store.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] A fork with a `parentID`, a parent state with ≥1 block, and stripped compress inputs recovers the parent's active blocks with message IDs remapped to the fork's raw IDs.
  - [x] Recovery is robust to the fork's ref shift (verified with `isSubAgent=true`): blocks map to the correct fork raw IDs, not shifted refs.
  - [x] `startId`/`endId` message refs are remapped to the fork's refs; `bN` block refs are preserved.
  - [x] Fork-local state is saved as an independent file; the parent state file is not mutated.
- **Performance / Stability**:
  - [x] Falls back to historical replay (returns 0) when: no parent state, no shared message prefix, parent has no blocks, or the parent message fetch fails.
  - [x] Parent nudge cadence / current-turn state is NOT copied into the fork.
- **Regression**:
  - [x] New test file `tests/rebuild-parent.test.ts` (7 tests) added and passing; full suite green (1084 pass / 0 fail).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/state/fork-transfer.ts` (new) — `recoverFromParentState()`.
  - `lib/state/state.ts` — fork init path calls parent-transfer first, then falls back to replay.
  - `lib/state/utils.ts` — new `getForkParentId()`; `isSubAgentSession` refactored to reuse it.
- **Risks**: mapping correctness if the fork copy reorders/drops messages (mitigated by position + `time.created` + role matching with a hard stop at the first mismatch); parent message fetch cost (one-time).
- **Rollback strategy**: revert the PR; the fork path reverts to replay-only behavior. No persisted-format migration.
