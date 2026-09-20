# DESIGN: source-availability gate for decompress

## Layer analysis (triage)

- **Symptom**: `Restored 1 message(s)` with empty preview; stats decremented for content that never returns to context.
- **Root cause**: the decompression commit path treats _membership transition_ (`activeBlockIds` → empty) as proof of _content restoration_. It never intersects the restored set with the IDs actually present in fetched host history. `computeRestoredMessages` does not even receive rawMessages.
- The issue's suggested direction (verify before commit, explicit missing reporting, fail closed) hits the root cause. Adopted.

## Key architectural facts that shape the design

1. A block's summary lives in its compress tool-call message in host history (`summary` param); originals are hidden from the window by `prune.filterCompressedRanges` while `entry.activeBlockIds.length > 0`.
2. Decompression = deactivate target blocks + `syncCompressionBlocks`. One-tier: consumed (non-user-deactivated) blocks are reactivated by sync, so their raw messages stay hidden and only the previous tier's compress-call messages become visible. Full: consumed blocks get `deactivatedByUserDeep` and stay dead, so ALL covered raw messages must return.
3. User-deactivated blocks are terminal (sync never reactivates them) — a blind deactivation with missing originals is irreversible.
4. `byMessageId` membership is bidirectional with `block.effectiveMessageIds` (built in `compress/state.ts`), and prune filters exactly on `entry.activeBlockIds`. So "which messages become visible" is a pure function of membership + sync reactivation semantics.

## Design

**Fail-closed pre-commit gate**, inserted between target resolution and the deactivation loop in `createDecompressTool.execute` (after the toFile branch, which makes no state changes).

New pure functions in `lib/compress/decompress-logic.ts`:

```ts
export interface DecompressAvailabilityResult {
    requiredMessageIds: string[] // IDs whose visibility this decompression would restore
    availableMessageIds: string[] // subset present in fetched history
    missingMessageIds: string[] // subset absent — non-empty ⇒ abort
}

export function collectRequiredDecompressMessageIds(
    messagesState: PruneMessagesState,
    targets: CompressionTarget[],
    options: { full?: boolean },
): string[]

export function checkDecompressSourceAvailability(
    messagesState: PruneMessagesState,
    targets: CompressionTarget[],
    options: { full?: boolean },
    availableMessageIds: Set<string>,
): DecompressAvailabilityResult
```

### Required set R (closed form, no state mutation)

For each `byMessageId` entry: include iff

1. `entry.activeBlockIds.length > 0`, AND
2. every ID in `entry.activeBlockIds` belongs to the target set T (exclusively covered by what we are about to kill — otherwise another live block still hides it, and its summary remains), AND
3. one-tier only: the ID is NOT in the union of `effectiveMessageIds` of the transitive consumed closure of T whose members would be reactivated by sync (not user-deactivated / not deep-deactivated). Those messages stay hidden under reactivated lower tiers, so they are not required sources.

Full mode skips condition 3 (everything under T must be present).

Why closed form instead of mutate→diff→rollback: zero crash window, no rollback code path, no partial-mutation risk. Cost: it mirrors sync's reactivation rule (non-user-deactivated consumed blocks revive). Soundness argument: over-inclusion in the shield set is safe (a shielded message either stays hidden under a revived block or under another live consumer — in both cases it is still covered, so excluding it from R can never let a false "restored" claim through). Over-requirement is possible only if a target-exclusive entry is also listed in a consumed block's `effectiveMessageIds` without that block reviving — which cannot happen: any consumed block of a target either revives (one-tier, non-user-flagged) or was already dead via user flags (then its messages were already exposed, i.e. their entries do not list the target exclusively… conservatively excluded anyway).

Note on empty `byMessageId`: when membership is unverified/empty, R = ∅ and the gate passes — consistent with existing behavior, because prune then filters nothing and `computeRestoredMessages` also reports nothing. The tool's restoration claim is exactly the membership-transition claim; verifying precisely those IDs against history closes the gap completely.

### Gate behavior

- `missingMessageIds.length > 0` → warn log + return an explicit error naming the target blocks, counts, and missing refs (via `state.messageIds.byRawId`, falling back to raw IDs). **No state mutation, no stat change.** Block stays compressed; summary remains available. Message also notes this is distinct from a transient fetch failure (that would have thrown in `prepareDecompressSession` before any mutation).
- Empty → proceed exactly as today. Because every ID in R is verified present, `computeRestoredMessages`' count/tokens are honest recovered-content numbers (acceptance #4 falls out for free).

### What we deliberately do NOT do

- No partial-commit mode (acceptance #3 default): restoring some originals while losing summary coverage semantics mid-block is worse than refusing; escape hatches (force flag / policy key) are future work, not requested here.
- No retry logic: fetch failure already surfaces as an exception before mutation; the two failure classes are structurally distinguished (acceptance #6 satisfied by construction + documented in the error text).
- toFile path untouched (#445 owns those field bugs).

## Known limitation (from dual-agent code review)

In one-tier nested decompress, what becomes visible after commit also includes the **reactivated consumed block's compress tool-call message** (its summary carrier), whose visibility is keyed on block liveness in `hideConsumedCompressCalls` — not on `byMessageId` membership. Compress calls are hard-protected, so carriers never have `byMessageId` entries and cannot enter R. If host history lost an intermediate tier's carrier while the topmost block is still resolvable, the gate passes, the commit proceeds, and the topmost summary is terminally discarded while nothing usable returns to context. Rare trigger (multi-tier nesting + selective deletion of exactly the intermediate carrier); pre-fix behavior was strictly worse (phantom claim + stats corruption on top). Fixing it properly means extending R with reactivating closure members' `compressMessageId`s — deliberately deferred: it changes R semantics beyond #446's stated scope (indexed originals) and needs its own review. Recorded here so the follow-up is findable; per project rules no separate issue is filed from this working session.

## Testing strategy

- Unit (extend `tests/decompress-logic.test.ts`): R computation for single-target, multi-target, one-tier nested (raws shielded, prev-tier compress call required), full nested (all required), unrelated overlapping active block (not required), empty membership (∅).
- Integration (new `tests/decompress-source-availability.test.ts`, reusing the `inactive-block-decompress.test.ts` harness with a controllable client history): all-missing aborts with exact message + zero state change; partial aborts listing only missing IDs; complete succeeds with correct restored count/tokens; nested one-tier succeeds with raws missing but prev-tier call present; nested full aborts; preview non-empty on success.
- Bug-detection proof: the integration all-missing test must fail against pre-fix code (it asserts the abort + no deactivation; pre-fix returns "Restored 1 message(s)" and deactivates). Verify by temporarily reverting the gate insertion.
