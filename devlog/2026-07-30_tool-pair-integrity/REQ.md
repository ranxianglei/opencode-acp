# REQ: Fix Issue #247 — Tool Pair Integrity in Compression Ranges

## Objective

Prevent compression ranges from splitting tool_use/tool_result pairs, which creates orphaned references that providers reject.

## Problem

In OpenCode's message format, a tool call spans two messages:
- **Assistant message** (tool_use): contains the tool call initiation
- **User message** (tool_result): contains the tool call response
Both share the same `callID`.

When a compression range boundary falls between these two messages:
- One is pruned (replaced with summary)
- The other survives, referencing a `callID` whose pair no longer exists
- Provider API rejects: "tool_result block does not have a corresponding tool_use"

## Fix

In `compress/search.ts`, `resolveBoundaryIds` now calls `adjustBoundariesForToolPairs` after boundary resolution. This function:
1. Collects all `callID`s from tool parts within the range
2. Scans forward (up to 20 messages) for tool_results with matching `callID`s → extends `endIdx`
3. Scans backward (up to 20 messages) for tool_uses with matching `callID`s → extends `startIdx`

The scan stops at the first non-matching message after finding at least one match, ensuring efficient O(k) scanning where k is the gap size.

## Scope

- `lib/compress/search.ts` — new `adjustBoundariesForToolPairs` function + integration in `resolveBoundaryIds`
- `tests/tool-pair-integrity.test.ts` — 9 tests covering forward/backward extension, parallel calls, gap tolerance, no-op cases

## Verification

- typecheck: clean
- tests: 947 pass (938 existing + 9 new), 0 fail
