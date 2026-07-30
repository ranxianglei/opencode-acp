# WORKLOG: acp-status-system-tokens

## Changes

1. `estimateContextComposition` (utils.ts): Added `systemTokens` field to `ContextComposition`. Estimated from first assistant message's `tokens.input + cache.read + cache.write` minus first user message text tokens (length/4). Added to `total`.

2. `status.ts`: Added private `estimateSystemTokens()` function. `collectVisibleMessages` returns `systemTokens`. `renderOverview` shows system in breakdown with `CONTEXT BREAKDOWN` header. Total now = system + tool + text + summaries.

3. `inject.ts`: Nudge breakdown prepends `system (N%)` when `composition.systemTokens > 0`. `compressibleTokens` now subtracts `systemTokens` (not compressible).

4. Tests: Updated `stats-command.test.ts` to expect `CONTEXT BREAKDOWN` instead of `VISIBLE CONTEXT`.

## Test Results

- 923 tests pass (0 failures)
- Typecheck clean
- Build success (382.42 KB)
