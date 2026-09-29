# DESIGN - V2 provider-checkpoint provenance guard

- Task ID: `2026-09-17_v2-checkpoint-provenance-guard`
- Date: 2026-09-17

## 1. Problem Shape

ACP's V2 layer normalizes a **projected** (public) history and correlates it with the **outgoing** (model-aware, lowered) request messages via provenance entries. Two views legitimately diverge across native provider compaction checkpoints in OpenCode V2:

```
public context (projected):  [checkpoint, nextUser]
outgoing after compatible model decode:      [decodedCheckpoint, nextUserLowered]
outgoing after incompatible model switch:    [originalUser, originalAssistant, nextUserLowered]
direct-tool view (host.ts passes []):        []
```

Before this change, `claimCheckpointRanges` claimed **every unclaimed outgoing index** between the previous source's last claimed index and the next source's first claimed index as checkpoint content. That is a positional inference: it works only when the window contains exactly the decoded checkpoint message itself.

## 2. Decision

**Claim by exact uniqueness, never by position.** Collect the unclaimed candidates in the window:

| Candidates | Meaning | Action |
|------------|---------|--------|
| exactly 1 | decoded checkpoint message | claim it (compatible case, unchanged behavior) |
| >1 | re-expanded originals from an incompatible model switch | leave all uncorrelated |
| 0 | checkpoint absent from the outgoing view (incompatible switch or direct-tool view) | leave uncorrelated |

Uniqueness here is positional, not content-based — see the first item in §5 for the single-re-expanded-original residual.

Consequences of "uncorrelated":

1. **Outgoing side**: each uncorrelated host message becomes its own `V2OutgoingProvenance` entry with `opaque: true` and `opaqueMessage = <message>` (`normalize.ts`, existing logic). The patcher rejects any non-object-identical replacement of such messages and keeps empty ones alive, so re-expanded originals survive into the final request byte-for-byte and remain individually identifiable in provenance.
2. **Normalized side**: `buildProviderCheckpoint` now renders the entry from source compaction data when it has no outgoing indices — `lowerCompactionText(source)` (existing `<conversation-checkpoint>` envelope with summary + recent context) under origin key `source:{i}:checkpoint:source`, opaque text origin/part. The direct-tool path therefore sees the checkpoint content instead of zero parts.
3. **Patch path safety** (verified in `patch.ts`): a normalized message whose entry has `outgoingMessageIndices: []` is skipped on removal without rejection; its opaque origins have no outgoing pointers so no content edits can be mapped; and because it carries a known normalized ID it can never become an ACP insertion — the fallback-rendered checkpoint is never injected into outgoing requests.
4. **Disclosure**: an unsupported window is disclosed structurally — `providerCheckpoint: true` with `outgoingMessageIndices: []` — and documented on `V2ProvenanceEntry.providerCheckpoint`. No rejection is raised: the projection remains valid and usable, which matches the issue's "safe explicit fallback" acceptance option.
5. **Restoration safety** (`restore.ts`, found during dual-agent review): once the shared engine compresses the normalized checkpoint away, `restoreMissingV2OpaqueSources` would otherwise reject the whole patch for an uncorrelated entry ("no exact lowered correlation") from `lib/v2/context.ts:187` — silently disabling every ACP edit for the rest of such sessions (a new failure mode this fix must not introduce). A provider checkpoint with empty indices is now skipped instead of restored: the outgoing request already carries its information as re-expanded host-owned originals, and fabricating a message the host never sent is worse than omitting one. Non-checkpoint opaque sources keep the fail-closed rejection.

## 3. Trade-offs Considered

- **Host-provided model-aware snapshot** (issue's first acceptance option): cleanest long-term, but requires new host API surface in OpenCode V2; not available to ACP today. Rejected for this iteration; the fallback covers both views without host changes.
- **Reject (>1 candidates) instead of fallback render**: fail-closed, but would break every incompatible-switch session outright; the divergence is benign once ownership stops being inferred, so degrading gracefully is safer.
- **Claiming extras conservatively (old behavior)**: keeps the checkpoint correlated even when provider-added messages sit in the window, but swallows host-owned content into opaque checkpoint territory — the exact misclassification this fix removes. Note the behavioral change: with provider-added extras present, the checkpoint renders from source data rather than decoded outgoing content. Acceptable because the entry stays opaque/protected/non-removable either way.

## 4. Invariants Preserved

- Compatible single-decoded-checkpoint windows correlate exactly as before (regression-locked by test).
- Opaque provider checkpoints remain protected and non-removable (`patch.ts` guard unchanged).
- No persisted-state format, internal-tag, or public-API signature changes.

## 5. Known Residual Limitations

- **Single re-expanded original is ambiguous** (pre-existing, not a regression): if the checkpoint covered exactly one transcript message and the incompatible switch re-expands just that one, the window holds exactly one candidate and ACP claims it as the decoded checkpoint — identical to pre-fix behavior. Content-preserving either way (the entry stays opaque/protected); hardening would require cross-checking against `source.providerContext`, which is empty for most checkpoints.
- **An earlier unclaimed checkpoint widens the next window**: windows are computed over all drafts in source order. If an earlier checkpoint is incompatible (claims nothing), its re-expanded originals sit inside the *next* checkpoint's candidate scan, pushing its count above 1 and leaving a genuinely compatible decoded checkpoint uncorrelated (rendered from source data instead of the decoded message). Fail-safe and content-preserving; do not "simplify" the windowing without re-reading this.
- **Multi-message decoded checkpoints are now uncorrelated**: pre-fix, a checkpoint lowering to multiple outgoing messages had all of them claimed; post-fix (>1 candidates) none are claimed. Content is still preserved via `lowerCompactionText`; correlation precision degrades only for providers that decode a checkpoint into more than one message.
