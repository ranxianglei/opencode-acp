# REQ - V2: keep provider checkpoints from claiming correlated tool messages

- Task ID: `2026-09-29_v2-checkpoint-reserved-tool`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: Done
- Priority: P1
- Owner: awork (ework agent)
- References: https://github.com/ranxianglei/opencode-acp/issues/456

## 1. Background & Problem Statement

- **Context**: V2 port of opencode-acp on OpenCode 2.0.x. A `providerContext` field on a completed compaction source marks a native provider checkpoint; `claimCheckpointRanges` (`lib/v2/projection/normalize.ts`) claims the checkpoint's decoded message from the outgoing view by window position.
- **Current behavior (symptom)**: When the checkpoint's window contains exactly one unclaimed index — the `role:"tool"` message that answers an unexecuted tool call of a source-bound assistant — the checkpoint claims it. The assistant's tool origin then has no result pointer, `loweredToolCorrelationIsExact` fails, and the whole session is rejected fail-closed with `invalid-source` ("Tool origin source:N:part:M has no exact lowered input/output match"). The tool result disappears from the model output entirely and ACP disables itself for the rest of the session.
- **Expected behavior**: The checkpoint must never claim indices owned by correlated sources (the assistant message carrying the tool call, or the role=tool result answering it). When its entire window is reserved that way, the checkpoint decoded nothing into this view and must emit no normalized message (structural sidecar disclosure only), while the session stays valid.
- **Impact**: Session-wide ACP outage on any native-compaction replay where the provider view still shows the correlated tool result; without `providerContext` the identical scenario passes.

## 2. Reproduction (if applicable)

- **Environment**: Node 22, linux; synthetic B2-shape replay through `normalizeV2ProjectedHistory` (captured lowered shape, not an interactive session).
- **Minimal reproduction steps**:
  1) projected = [user, assistant(unexecuted tool call), compaction(completed) + `providerContext`]
  2) outgoing = [user(0), assistant(1) with tool-call part, role:"tool"(2) with matching tool-result part]
  3) Run `normalizeV2ProjectedHistory(projected, outgoing, {sessionID, agent, currentModel})`
- **Observed before fix**:
  ```
  without providerContext: valid=true   aidx=[1,2] result={2,0} origLen=2
  with    providerContext: valid=false  aidx=[1]   result=undefined origLen=1 ckptIdx=[2]
                          invalid-source "Tool origin source:1:part:0 has no exact lowered input/output match"
  ```
- **Relevant configuration**: none (pure projection logic).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: all existing provider-checkpoint behaviors are pinned by tests in `tests/v2-message-projection.test.ts` and must stay green: single-candidate claim in the compatible view, re-expanded-originals non-claim after an incompatible switch, render-from-source for the direct view with empty outgoing history.
  - Internal `dcp` naming / persisted state untouched (change is confined to V2 projection runtime state).
- **Non-Goals** (explicitly out of scope):
  - #425 public-context vs runner-history boundary semantics (already fixed; this issue builds on it).
  - Correlating results for assistants that failed ID correlation (unsource-bound assistants do not reserve indices).
  - Repo-wide Prettier drift (pre-existing on this line; only touched files kept clean).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Under `providerContext`, the repro shape yields `valid=true`, tool origin `result = {messageIndex: 2, contentIndex: 0}`, `originalContent.length === 2`.
  - [x] The wholly-reserved checkpoint emits no normalized message: entry has `providerCheckpoint: true`, `outgoingMessageIndices: []`, no `normalizedMessageId`, no origins; no contentless assistant turn enters `projection.messages`.
  - [x] The patcher accepts the projection and keeps every outgoing message object-identical (ACP stays alive).
  - [x] Partial-window guard: a checkpoint whose window mixes one reserved result index and one free index keeps the tool-free remainder (`outgoingMessageIndices` = free index) and renders it opaque.
  - [x] Control without `providerContext` unchanged: same result pointer as before.
  - [x] New tests fail when the fix is reverted (verified via temporary revert of `lib/v2/projection`).
- **Performance / Stability**:
  - [x] Full suite green (except pre-existing environment-only failure `tests/soft-block.test.ts`: hard-codes `/tmp` mkdir, read-only in this sandbox; fails at import time on pristine base too).
