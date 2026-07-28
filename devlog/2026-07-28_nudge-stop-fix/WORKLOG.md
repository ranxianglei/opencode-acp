# WORKLOG: Fix nudge permanently stops after compress in autonomous sessions

## Timeline

### Step 1: Bug reproduction (unit test)
- Wrote two tests in `tests/inject.test.ts`:
  - "E2E autonomous: nudge re-fires after compress in same turn (Issue #176)"
  - "E2E autonomous: second compress also gets processed (Issue #176 multi-compress)"
- Both tests FAILED at Phase 3 (nudge should re-fire after compress + growth) — bug confirmed
- Test pattern: single user message + 20 assistant/tool msgs → first nudge → compress → 20 more msgs → second nudge SHOULD fire

### Step 2: Fix implementation
- Added `lastProcessedCompressMessageId: string | undefined` to `Nudges` interface (NOT persisted — transient by design)
- Modified `injectCompressNudges` early-return block:
  - Find last compress message ID via `findLast`
  - If ID !== `lastProcessedCompressMessageId`: process compress (existing behavior), store ID, set `shouldInjectThisTurn = false`, return early
  - If ID === `lastProcessedCompressMessageId`: skip early return, fall through to normal evaluation
- When no compress in turn: reset `lastProcessedCompressMessageId = undefined`

### Step 3: Verification
- 917 tests pass (2 new + 915 existing)
- TypeScript typecheck clean
- Build clean (427KB)

### Step 4: E2E tests
- Scenario 09: Multi-turn nudge→compress→growth→re-nudge→compress (verifies minBlockCount ≥ 2)
- Scenario 10: Autonomous session using bash tool calls to grow context within single user turn (exact Issue #176 reproduction)
- Extended `fake-llm-server.ts` with `autonomous-nudge` response type that emits bash tool calls to continue growing context
- Added both scenarios to CI workflow

## Key Design Decisions

1. **NOT persisted**: `lastProcessedCompressMessageId` is transient — on restart it's `undefined`, causing one extra early-return on the first call, then normal behavior resumes. This is safe because the worst case is one missed nudge evaluation.

2. **Message ID tracking (not counter)**: Using message ID instead of a counter because:
   - Multiple compress calls in the same turn each have unique message IDs
   - A new compress (different ID) should always be processed
   - An old compress (same ID) should be skipped

3. **`shouldInjectThisTurn = false` in early return**: Explicitly set to prevent stale `true` value from previous nudge evaluation leaking into the next call.
