# WORKLOG: nudge-gating

Branch: `ranxianglei/2026-06-28_nudge-gating`
Date: 2026-06-28

## Changes

### State (new fields on `Nudges`)

- `lib/state/types.ts` — added `lastPerMessageNudgeTurn: number` and
  `lastPerMessageNudgeTokens: number` to the `Nudges` interface.
- `lib/state/state.ts` — initialised both fields to `0` in
  `createInitialState()` and in the reset path.
- `lib/state/utils.ts` — initialised both fields to `0` in the compaction
  reset path (`resetTransientState`).

### Persistence

- `lib/state/persistence.ts` — added the two fields (optional) to
  `PersistedNudges` and serialised them in `saveSessionState`.
- `lib/state/state.ts` — restore the persisted values into the live
  `SessionState` in `loadState` (deserialisation), falling back to `0`.

### Gating logic

- `lib/messages/inject/inject.ts`
    - Added `shouldInjectPerMessageNudge(state, config, currentTokens,
modelContextLimit)`: returns `true` when `turnsSinceLast >= nudgeFrequency`
      **or** token growth since last nudge is ≥ 3% of the context limit.
    - `injectContextUsage` gained a `minimal` boolean (default `false`),
      forwarded to `buildContextUsageGuidance`.
    - The suffix-message injection block now:
        - computes `shouldNudge`,
        - passes `!shouldNudge` as `minimal` to `injectContextUsage`,
        - passes `includeHint: shouldNudge` to `buildCompressedBlockGuidance`,
        - updates `lastPerMessageNudgeTurn` / `lastPerMessageNudgeTokens` when a
          nudge fires.

### Guidance builders

- `lib/messages/inject/utils.ts` — `buildContextUsageGuidance` gained a
  `minimal: boolean = false` parameter. When `true`, returns only the base
  usage line (token count + percentage) without the tiered guidance suffix.
- `lib/prompts/extensions/nudge.ts` — `BlockGuidanceContext` gained
  `includeHint?: boolean` (default `true`). When `false`, the
  "💡 compress tool outputs" line is omitted from `buildCompressedBlockGuidance`.

## Verification

- `npm run typecheck` — clean (0 errors).
- `npm run test` — 486 pass / 0 fail (no behaviour change to tested paths).

## Files touched

- `lib/state/types.ts`
- `lib/state/state.ts`
- `lib/state/utils.ts`
- `lib/state/persistence.ts`
- `lib/messages/inject/inject.ts`
- `lib/messages/inject/utils.ts`
- `lib/prompts/extensions/nudge.ts`
