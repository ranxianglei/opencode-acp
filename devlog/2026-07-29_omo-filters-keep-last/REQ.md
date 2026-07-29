# REQ: OMO Filters — keepLastOnly Dedup + 4 New Builtin Filters

## Problem

OMO injects repeating directives (TODO CONTINUATION, CONTEXT, TASK) as separate
user messages. A single session can accumulate 387 TODO reminders (~120K tokens).
Stripping ALL of them loses the active directive (model stops working).

## Solution

- [x] Add `keepLastOnly` property to `MessageFilter` interface
- [x] Two-phase filtering in `applyMessageFilters`: Phase 1 (immediate, forward),
      Phase 2 (keepLastOnly, reverse dedup)
- [x] 4 new builtin filters: `omo-todo-continuation`, `omo-context`,
      `omo-task-directive` (keep last), `omo-mode-injection` (strip all)
- [x] Config defaults updated with all 5 filters enabled
- [x] Tests: keep-last dedup (TODO, CONTEXT, single occurrence), mode injection strip

## Acceptance Criteria

- [x] 927/927 tests pass
- [x] TypeScript 0 errors
- [x] DB verification: 316 pure system-reminder dropped, 3 mixed modified, 0 false positives
