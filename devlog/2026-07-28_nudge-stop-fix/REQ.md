# REQ: Fix nudge permanently stops after compress in autonomous sessions (Issue #176)

## Problem

In autonomous sessions (single user message, multiple LLM calls), the nudge system permanently stops firing after the first compress call. This causes context to grow unbounded until overflow, with no further ACP compression nudges.

**Root cause**: `injectCompressNudges` in `lib/messages/inject/inject.ts:109-161` has an unconditional early return when `currentTurnHasCompress` is true. In autonomous sessions, `currentTurnStart = lastUserIdx + 1 = 1`, so ALL assistant messages are in the "current turn." Once a compress happens, `currentTurnHasCompress` is ALWAYS true for every subsequent call → function ALWAYS returns early → nudges NEVER fire again.

**Impact**: After the first compress in an autonomous session, the model receives no more compression nudges. Context grows until overflow, degrading model quality and eventually causing failures.

## Fix

Track `lastProcessedCompressMessageId` on the `Nudges` interface. When compress is detected:
- If the compress message ID is NEW (different from last processed): process it (clear anchors, adjust baseline), store the ID, return early
- If the compress message ID is the SAME (already processed): fall through to normal nudge evaluation

This ensures each compress is processed exactly once, and subsequent calls evaluate nudges normally.

## Test Coverage

1. **Unit tests** (`tests/inject.test.ts`): Two tests reproducing the exact bug scenario (single user message + multiple assistant/tool messages + compress + more growth → verify second nudge fires)
2. **E2E scenario 09** (`09-nudge-refire-after-compress.json`): Multi-turn regression — nudge→compress→growth→second nudge→second compress
3. **E2E scenario 10** (`10-autonomous-nudge-refire.json`): Autonomous session simulation — bash tool calls grow context within a single user turn, testing the exact Issue #176 scenario

## Files Changed

- `lib/state/types.ts` — Add `lastProcessedCompressMessageId` to `Nudges` interface
- `lib/state/state.ts` — Add default value in two state creation sites
- `lib/state/utils.ts` — Add default value in defaults
- `lib/messages/inject/inject.ts` — Core fix: track processed compress, skip early return for already-processed compress
- `tests/inject.test.ts` — Two regression tests
- `scripts/e2e/fake-llm-server.ts` — Add `autonomous-nudge` response type
- `scripts/e2e/scenarios/09-nudge-refire-after-compress.json` — Multi-turn regression
- `scripts/e2e/scenarios/10-autonomous-nudge-refire.json` — Autonomous regression
- `.github/workflows/ci.yml` — Add scenarios 09 and 10 to CI
- `scripts/e2e/README.md` — Document new scenarios
