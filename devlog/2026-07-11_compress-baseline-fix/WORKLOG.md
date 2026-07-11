# WORKLOG: Fix compress baseline tracking bug

## Date: 2026-07-11

## Branch: `2026-07-11_compress-baseline-fix`

## Changes

### `lib/messages/inject/inject.ts` (line 96-98)

Before:
```ts
state.nudges.lastPerMessageNudgeTokens = currentTokens
```

After:
```ts
// currentTokens reflects PRE-compression context; baseline must wait
// for the next API response to capture the real post-compression level.
state.nudges.lastPerMessageNudgeTokens = undefined
```

### `tests/inject.test.ts` — 3 tests updated

1. **Renamed**: "after compress, baseline cleared to undefined for re-establishment"
   - Was: asserts `lastPerMessageNudgeTokens === 250_000`
   - Now: asserts `lastPerMessageNudgeTokens === undefined`

2. **Renamed**: "post-compress baseline re-establishment then small growth does NOT re-nudge"
   - Turn 1: compress → baseline = undefined
   - Turn 2: baseline established from post-compression API tokens → no nudge

3. **Renamed**: "post-compress baseline re-establishment then large growth DOES nudge"
   - Now a 3-turn sequence:
     - Turn 1: compress → baseline = undefined
     - Turn 2: baseline established (305K) → no nudge
     - Turn 3: growth to 361K (56K > 50K threshold) → nudge

## Verification

- `npm run typecheck`: 0 errors
- `npm run test`: 619 tests pass, 0 failures
