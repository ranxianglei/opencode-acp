# REQ - V2 provider-checkpoint provenance guard

- Task ID: `2026-09-17_v2-checkpoint-provenance-guard`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/425

## 1. Background & Problem Statement

- **Context**: OpenCode V2 serves two different histories for the same session: the public context (`session.context`, used by ACP direct tools) always starts at the latest native compaction checkpoint, while the model-aware runner history excludes an incompatible provider checkpoint and re-expands the original transcript underneath it.
- **Current behavior (symptom)**:
  1. `claimCheckpointRanges` claims every unclaimed outgoing message in the positional window around a provider checkpoint. After an incompatible model switch that window contains the re-expanded originals, so they are misclassified as opaque checkpoint content — neither original ID is individually addressable in provenance.
  2. When the checkpoint is absent from the outgoing view entirely (direct-tool path passes `outgoing = []`), `buildProviderCheckpoint` loops over zero indices and normalizes the checkpoint to zero parts, so the model loses the checkpoint's summary/recent context on the direct path.
- **Expected behavior**: Checkpoint ownership must be established only by exact identity, never inferred from array position. Uncorrelated outgoing messages stay individual opaque host entries. The checkpoint remains visible in the normalized view from source compaction data even when it has no outgoing counterpart. Unsupported windows are disclosed via the entry shape (`providerCheckpoint: true` + empty `outgoingMessageIndices`).
- **Impact**: Public context and runner history diverge silently; ACP could treat host-owned re-expanded messages as removable/checkpoint-owned, and direct tools see a checkpoint with no content.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22
  - OS/Arch: linux
- **Minimal reproduction steps** (isolated adapter repro from issue floor 2, official v2.0.3 `toLLMMessages`):
  1) Public context: `[nativeCheckpoint, nextUser]`; outgoing request: `[originalUser, originalAssistant, nextUser]` after an incompatible model switch.
  2) Normalize → checkpoint entry claimed outgoing `[0, 1]` as opaque; original IDs unaddressable.
  3) Direct-tool view (`outgoing = []`) → checkpoint normalized to zero parts.
- **Relevant configuration**: none (V2 projection defaults).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no persisted-state or internal-tag changes; existing compatible-checkpoint behavior (single decoded message claimed) must be unchanged.
  - Performance requirements: no new allocations beyond the candidate collection per checkpoint entry.
  - Resource limits: fail-closed philosophy preserved — never guess ownership; when ambiguous, keep everything opaque/uncorrelated.
- **Non-Goals** (explicitly out of scope):
  - Switching ACP to a host-provided model-aware source snapshot (would require new host API surface; the safe explicit fallback chosen here covers both views).
  - Fixing the pre-existing direct-view rejection (`Patchable origin ... has no exact lowered outgoing match`) that occurs for any user/assistant source with empty outgoing — recorded as a finding in issue #425, not fixed here.
  - Fixing `tests/soft-block.test.ts` hardcoding `/tmp/opencode-dcp-dangerous-*` (fails only where `/tmp` is read-only; environmental).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Compatible native checkpoint (exactly one unclaimed candidate in window) is still claimed and rendered from outgoing content; patch round-trip keeps it object-identical.
  - [x] Incompatible model switch with re-expansion (>1 candidates): checkpoint stays uncorrelated (`outgoingMessageIndices: []`), renders from source compaction data; each re-expanded original remains its own opaque host entry; no-op patch keeps all outgoing messages object-identical and injects nothing.
  - [x] Direct-tool view (`outgoing = []`) (0 candidates): checkpoint renders summary + recent context instead of zero parts.
  - [x] Unsupported window disclosed through entry shape + documented on `V2ProvenanceEntry.providerCheckpoint`.
- **Performance / Stability**:
  - [x] No new failure modes: all previous v2 projection/patch tests still pass.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing (`tests/v2-message-projection.test.ts`); bug-catching tests verified to FAIL at HEAD without the fix.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/v2/projection/normalize.ts` — `claimCheckpointRanges`, `buildProviderCheckpoint`
  - `lib/v2/projection/types.ts` — disclosure doc comment on `V2ProvenanceEntry.providerCheckpoint`
  - `tests/v2-message-projection.test.ts` — 3 new tests
- **Risks**: Windows where the provider adds extra messages between the checkpoint and the next correlated source now leave the checkpoint uncorrelated (rendered from source data) instead of claiming extras. Acceptable: the entry stays opaque/protected/non-removable either way, and extras remain individually addressable.
- **Rollback strategy**: Revert the single commit; no state migration involved.
