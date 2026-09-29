# DESIGN - V2: keep provider checkpoints from claiming correlated tool messages

- Task ID: `2026-09-29_v2-checkpoint-reserved-tool`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** `claimCheckpointRanges` expands each provider checkpoint across the index window between its neighbouring sources and claims the single unclaimed candidate — even when that candidate is a correlated tool message (the assistant message carrying an unexecuted tool call, or the `role:"tool"` result answering it). The stolen result breaks exact-correlation validation and disables ACP fail-closed for the whole session (#456).
- **Why now?**: Live-repro shape captured on OpenCode 2.0.18; every native-compaction replay with this shape loses the tool result and turns ACP off until restart.

## 2. Goals & Non-Goals

- **Goals**:
  - Checkpoints never claim source-owned indices; the session stays valid and the tool result survives into the outgoing request.
  - A wholly-reserved checkpoint discloses itself structurally (sidecar entry) without injecting a contentless assistant turn into the algorithm projection.
  - All pre-existing checkpoint claim behaviors (compatible single-candidate claim, incompatible-switch non-claim, direct-view render-from-source) unchanged.
- **Non-Goals**:
  - Changing #425's exactly-one-candidate rule or its re-expanded-originals semantics.
  - Reservation for assistants that failed ID correlation (they are not "source-bound").
  - Any persisted-state or internal-tag migration (none needed — runtime-only state).

## 3. Current Architecture (if applicable)

- **How it works today**: `normalizeV2ProjectedHistory` builds outgoing index maps → per-source drafts → ID correlation (claims indices; checkpoints skipped) → `claimCheckpointRanges` (window = between max preceding and min following correlated indices; claim iff exactly one unclaimed candidate) → post-checkpoint role=tool result correlation (skips claimed indices by design) → origin exact-correlation validation (fail-closed).
- **Pain points**: Step 4's candidacy test is purely positional ("unclaimed"), blind to ownership; step 5 deliberately skips claimed indices, so a step-4 theft is unrecoverable downstream.

## 4. Proposed Architecture

- **Overview**:

```
ID correlation ──► reservedForCorrelatedTools (new)
                       │  = assistant own indices ∪ role=tool results of their call IDs
                       ▼
claimCheckpointRanges(drafts, outgoing, claimed, reserved)
   candidates = window \ (claimed ∪ reserved)
   ├─ 1 free        → claim it (unchanged rule)
   ├─ >1 free       → no claim (unchanged: re-expanded originals / ambiguous)
   └─ 0 free, window non-empty → draft.whollyReserved = true (new)
                       │
buildProviderCheckpoint
   ├─ whollyReserved → return: no normalized message (sidecar disclosure only)
   └─ else           → render from claimed index(es) or source data (unchanged)
```

- **Key components**:
  - `reservedForCorrelatedTools: Set<number>` — computed once after ID correlation, before claiming; source-bound assistants only.
  - `Draft.whollyReserved?: boolean` — new optional flag, set only by the claimer, consumed only by `buildProviderCheckpoint`.
- **Data flow**: identical to today except the candidate scan excludes reserved indices and the fully-reserved branch suppresses normalized output. The post-checkpoint result loop then finds the result among *unclaimed* indices as designed, so `loweredToolCorrelationIsExact` passes.

## 5. Alternatives Considered

- **Move result correlation before checkpoint claiming** — rejected: inverts the deliberate ordering from #425 ("Claiming is done after checkpoint regions so decoded provider messages are kept opaque rather than accidentally attributed to an assistant call"); a decoded provider message containing a tool-result part would be misattributed.
- **Let the checkpoint keep the stolen index but also share it with the assistant** — rejected: one outgoing index cannot carry two provenances; the patcher's opaque/owned accounting assumes exclusive ownership.
- **Reject the checkpoint (fail the session) when its window is reserved** — rejected: fail-closed on benign shapes is exactly what made #456 severe; structural disclosure keeps ACP alive.
