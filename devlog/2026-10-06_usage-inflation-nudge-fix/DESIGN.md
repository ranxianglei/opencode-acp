# DESIGN — Usage sanity gate + empty-range nudge suppression + free-span recovery hint

## 1. Usage sanity gate (AC1 + AC2)

### Why not estimate-only?

`estimateAllMessageTokensFast` is chars/4. For CJK-heavy content chars/4
undercounts real tokens by up to ~4×. Replacing the reported figure with the
estimate in **all** cases would systematically undercount for honest providers
and shift every calibrated threshold (min/max limits, growth floors, emergency
override) — a larger regression than the bug it fixes. Honest reports must stay
authoritative; estimates are used only to _detect_ and _repair_ inflated
reports.

### Detection: jump-based, stateful, floor-guarded

New module `lib/usage-sanity.ts`:

```ts
RELAY_INFLATION_RATIO = 1.5   // issue-mandated jump threshold
PAYLOAD_FLOOR_TOKENS  = 5000  // below this, ratios are noise

estimatePayloadTokens(messages)   // Σ estimateAllMessageTokensFast over non-synthetic, non-ignored messages
resolveCurrentUsage(state, messages, logger?) → { tokens, source: "reported" | "reestimated", inflationDetected }
```

Per call:

1. `reported = getCurrentTokenUsage(state, messages)`. If `reported === 0`
   (post-compaction sentinel) → return `{tokens: 0, source: "reported"}`
   unchanged — legacy behavior preserved exactly.
2. `estimated = estimatePayloadTokens(messages) + (state.systemPromptTokens ?? 0)`
   — payload + cached system-prompt count (provider-derived, accurate).
3. If a previous-turn record exists (`state.usageSanity`) with
   `prev.reported > 0` and both current and previous estimates ≥
   `PAYLOAD_FLOOR_TOKENS`:
    - `reportRatio = reported / prev.reported`
    - `payloadRatio = estimated / prev.estimated`
    - **inflation detected** iff `reportRatio > 1.5 && payloadRatio <= 1.5`.
4. Always store `state.usageSanity = { reported, estimated }` (the honest pair).
   Storing the raw reported value each turn means a relay that keeps reporting
    > 1.5× per turn relative to its own previous report is caught every turn.
5. On detection: warn-log with all five numbers, return `{tokens: estimated,
source: "reestimated", inflationDetected: true}`. Otherwise return
   `{tokens: reported, source: "reported"}`.

### Known limitation (documented, accepted)

A relay that inflates **once** and then holds a stable inflated value passes
the jump test on subsequent turns (ratio ≈ 1). The #476 evidence shows bursty
inflation (3 discrete reports across the session), which the jump gate catches.
An absolute `reported >> estimated` check was rejected because chars/4
undercounts CJK payloads by up to 4× — it would false-positive on legitimate
CJK sessions. A future refinement could use a CJK-aware estimator there.

### Persistence

`SessionState.usageSanity?: { reported: number; estimated: number }` — new
optional field, persisted via `PersistedSessionState`, restored in
`ensureSessionInitialized` with numeric validation (invalid/absent → undefined,
detection skips one turn). Old state files load cleanly (field simply absent).

### Call-site swaps

The sanitized value replaces `getCurrentTokenUsage` at exactly the three sites
that feed threshold/growth decisions, keeping ONE consistent channel through
limits, growth baseline, and pre/post logging:

| Site                                                       | Before                                  | After                                                        |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `lib/messages/inject/utils.ts:197` (`isContextOverLimits`) | `getCurrentTokenUsage(state, messages)` | `resolveCurrentUsage(state, messages).tokens`                |
| `lib/hooks.ts` `prePruneTokens`                            | same                                    | `resolveCurrentUsage(state, output.messages, logger).tokens` |
| `lib/hooks.ts` `postTokens`                                | same                                    | same                                                         |

Other `getCurrentTokenUsage` callers (compress pipeline, decompress, gc/merge,
truncate-tools, enforce-budget) are left untouched — they operate on explicit
message ranges or post-compression deltas, not on cross-turn growth inputs.

Two calls per transform (pre + post) are harmless: the second call compares
against the first call's same-turn write (ratio ≈ 1, no false detection) and
stores the post-prune pair as the best cross-turn baseline.

`isContextOverLimits` keeps its signature (no logger param) so existing tests
remain valid; the warn log fires from the hooks.ts call sites instead.

## 2. Empty-range nudge suppression (AC3)

In `injectCompressNudges`, add:

```ts
const noRangesAtAll =
    contextRanges.compressible.length === 0 && contextRanges.protected.length === 0
const nothingToCompress =
    (candidatesEnabled && candidateMessages !== undefined
        ? noExecutableCandidates
        : allProtected || allInProtectedZone || allBelowMin) || noRangesAtAll
```

This closes the vacuous hole: zero compressible ranges AND zero protected
messages means the nudge has nothing actionable, regardless of mode. The
suppression audit log gains reason `"no_compressible_ranges"`. In an emergency
(`emergencyOverride`) the flow now falls into the existing cadence-gated
`/compact` notice path (`emergencyNoTargets`) instead of injecting a fake
growth nudge — graceful degradation matching Issue #216's residual handling.

Behavior change vs. before: turns that previously injected a growth nudge with
zero recommended ranges now suppress it (and log why). This is the fix itself.

## 3. Free-span recovery hint (AC4)

`buildBoundaryRecoveryHint` (compress/search.ts) rewritten: instead of
"Current visible: m00001–m00263 (N msgs)" (which implies continuity that may
not exist), enumerate the actual contiguous FREE spans of visible message refs:

- Collect refs from `state.messageIds.byRef` ∩ `context.rawMessagesById`
  (i.e., refs whose message is still visible), parse to indexes, sort.
- Group consecutive indexes into spans; render single refs or `mNNNNN–mMMMMM`.
- Cap at 8 spans + `…+N more`.
- Keep the active-block-count sentence; end with
  "Retry with IDs inside the free ranges."

Error text on unresolvable boundaries changes accordingly (disclosed as a
behavior change).

## 4. Testing strategy (AGENTS.md §5.7 compliance)

- `tests/usage-sanity.test.ts` — unit tests of `estimatePayloadTokens` +
  `resolveCurrentUsage` over multi-turn sequences sharing one SessionState:
  honest steady state → reported; 1.76× jump with stable payload → reestimated;
  legit proportional growth → reported; first turn (no prev) → reported;
  compaction sentinel (reported=0) → passthrough; sub-floor guard; state record
  updated every turn; persistence round-trip validation.
- `tests/nudge-no-ranges-suppression.test.ts` — multi-turn
  `injectCompressNudges` with production config (`preserveRecentMessages > 0`):
  scenario where all visible context falls in the recent zone / compressed
  blocks → zero ranges → assert `shouldInjectThisTurn === false` AND side
  effects (`lastPerMessageNudgeTokens`, `lastNudgeShownTokens`) unchanged;
  control case with older unprotected messages → nudge fires. Verified to FAIL
  against unfixed code (temp revert).
- `tests/boundary-recovery-hint.test.ts` — `resolveBoundaryIds` error text with
  gapped refs enumerates multiple spans; contiguous → single span; cap behavior.
