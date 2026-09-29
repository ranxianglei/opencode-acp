# WORKLOG - V2: keep provider checkpoints from claiming correlated tool messages

- Task ID: `2026-09-29_v2-checkpoint-reserved-tool`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-29 18:30

## 1. Summary

- **What was done**: `claimCheckpointRanges` now skips source-reserved indices (tool-call messages of correlated assistants and the role=tool results answering their calls); a checkpoint whose entire window is reserved sets a new `Draft.whollyReserved` flag and `buildProviderCheckpoint` then emits no normalized message for it. Code review (dual-agent) then found the same fail-closed symptom one layer downstream: `restoreMissingV2OpaqueSources` rejected any protected entry without a normalized message, so the new sidecar-only checkpoint shape would have disabled ACP again in `lib/v2/context.ts`; it now exempts `providerCheckpoint` entries (nothing exists to restore).
- **Why**: The single-candidate claim rule from #425 did not inspect *what* the candidate was; claiming a correlated tool result stripped the result from its call, failed exact-correlation validation, and disabled ACP fail-closed for the whole session (#456).
- **Behavior / compatibility changes**: Yes — intended, issue-scoped:
  - Old → new: provider checkpoint with a window consisting solely of correlated tool indices used to claim the index and crash the session (`invalid-source` rejection); now it claims nothing, discloses structurally (sidecar entry, `providerCheckpoint: true`, empty indices), and the session stays valid with the tool result intact in the outgoing request.
  - Old → new (partial windows): a checkpoint window mixing reserved and free indices used to claim nothing when >1 unclaimed candidate existed; it now claims the free remainder per the existing exactly-one-candidate rule. This matches the issue's guard ("the checkpoint's own `outgoingMessageIndices` must keep the tool-free remainder").
   - Old → new (restore layer): a wholly-reserved provider-checkpoint entry (no normalized message) used to be rejected by `restoreMissingV2OpaqueSources` ("Opaque source … has no normalized source message"), which `lib/v2/context.ts` turns into "preserve provider request" = ACP off for the session; now such entries are exempt from the missing-normalized-source rejection because no message exists that could have been dropped.
   - Unchanged: compatible-view single decoded-message claim, incompatible-switch re-expanded-originals non-claim, direct-view render-from-source (empty window never sets the flag), plain compactions without `providerContext`; all other restore rejection paths (missing correlation, duplicate IDs, out-of-order sources) untouched.
- **Risk level**: Low — confined to V2 projection runtime state; all pre-existing checkpoint behaviors pinned by tests remain green.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `b67f433f` | fix: keep provider checkpoints from claiming correlated tool messages (#456) |
| (accompanies this WORKLOG update) | fix: exempt wholly-reserved provider checkpoints from opaque-source restoration (#456 review finding) |

### Key Files

- `lib/v2/projection/types.ts` — `Draft.whollyReserved?: boolean` flag (set only by the claimer on fully-reserved checkpoint drafts); `providerCheckpoint` contract comment documents the third empty-indices shape and the multi-checkpoint residual limitation.
- `lib/v2/projection/normalize.ts` — reserved-index set computed after ID correlation (source-bound assistants only); `claimCheckpointRanges` takes the set, skips reserved candidates, flags wholly-reserved windows (`end > start && candidates.length === 0`); `buildProviderCheckpoint` returns early on the flag so no contentless assistant turn enters the projection.
- `lib/v2/projection/restore.ts` — `rejectsMissingNormalizedSource` exempts `providerCheckpoint` entries (wholly-reserved checkpoints intentionally have no normalized message; nothing can be dropped or restored).
- `tests/v2-message-projection.test.ts` — two new T2.x unit tests + shared fixture helpers (`providerCheckpointSource`, `hostToolSource`).
- `tests/v2-context-patch.test.ts` — context-level regression test through `restoreMissingV2OpaqueSources` + `applyV2ContextPatch` for the wholly-reserved shape (pins the restore-layer rejection found in review).

## 3. Design & Implementation Notes

- **Entry point / key function**: `normalizeV2ProjectedHistory` → `claimCheckpointRanges(drafts, outgoing, claimedMessages, reservedForCorrelatedTools)`.
- **Key logic explanation**:
  - Reserved set = union over source-bound assistant drafts (non-empty `outgoingMessageIndices`) of their own indices plus every index in `outgoingRoleToolResultIndicesByCallId.get(callID)` for each tool call ID in their content. Source-bound restriction follows the issue spec ("a source-bound assistant already correlates"); an assistant that failed ID correlation reserves nothing.
  - At claim time no window index can be already-claimed (the window sits strictly between the max preceding and min following correlated indices), so `candidates.length === 0 && end > start` precisely means "whole window reserved". The `end > start` guard keeps the empty-window cases (direct view with empty outgoing; adjacent sources) on the existing render-from-source path.
  - The post-checkpoint result-correlation loop is untouched: with the index no longer claimed, `aiToolResultPointer` finds the role=tool result among unclaimed indices and the exact-correlation check passes.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck                 # clean
node --import tsx --test tests/v2-message-projection.test.ts   # 10/10 pass
node --import tsx --test tests/v2-context-patch.test.ts        # 26/26 pass
npm test                          # 1417/1418 pass; 1 env-only failure (see below)
npx prettier --check lib/v2/projection/{normalize,restore,types}.ts tests/v2-message-projection.test.ts  # clean
```

### Results

- New test "keeps correlated tool results out of provider-checkpoint claims": asserts the issue's expected values verbatim (`result = {messageIndex: 2, contentIndex: 0}`, `originalContent.length === 2`, wholly-reserved checkpoint emits no normalized message) plus patch acceptance with object-identical outgoing messages. FAILS on unfixed code (verified by temporary revert of the lib changes), PASSES with the fix.
- New test "lets a provider checkpoint claim its tool-free remainder beside a reserved result": pins the partial-window guard. Also fails without the fix.
- New context-level test "keeps patches alive when a wholly-reserved provider checkpoint emits no normalized message" (`tests/v2-context-patch.test.ts`): runs the repro shape through `restoreMissingV2OpaqueSources` and then `applyV2ContextPatch`. FAILS when only the restore.ts exemption is reverted ("Opaque source reserved-checkpoint has no normalized source message"), PASSES with it — verified via `git stash push -- lib/v2/projection/restore.ts`.
- Full suite: 1417 pass / 1 fail. The failure is `tests/soft-block.test.ts` — `EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-*'` at import time (line 14 hard-codes `/tmp`; this sandbox mounts `/tmp` read-only). Pre-existing environment artifact, unrelated to this change; passes where `/tmp` is writable (CI).

## 5. Independent Review Pass (PR #468, 2026-09-29)

- Re-verified on the pushed head before this commit: typecheck clean; full suite 1417/1418 (sole failure = env-only `/tmp` EACCES in `tests/soft-block.test.ts`, reproduced in isolation); claim/restore logic re-traced independently (reserved set computed after ID correlation and before claims; `claimed ∩ reserved = ∅` invariant holds for all window shapes incl. `end <= start`; `lib/v2/projection/patch.ts:923` filters entries without `normalizedMessageId`, so wholly-reserved sidecar-only entries never enter patcher source loops).
- Fix applied in this commit: `tests/v2-context-patch.test.ts` was not prettier-clean — two long lines introduced by prerequisite commit `37654026` (test "keeps patches alive when an uncorrelated provider checkpoint is compressed away"). Ran `npx prettier --write`; all five touched files now pass `prettier --check`. No behavioral change (whitespace/wrapping only).
