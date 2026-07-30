# WORKLOG

## Phase 1: DB Analysis
- Scanned 319 system-reminder messages: 316 pure, 3 mixed, 0 false positives
- Categorized 1180 OMO-injected parts: todo-continuation (387), background-task (316), context (201), task-directive (28)
- Estimated total savings: ~200K+ tokens per session

## Phase 2: keepLastOnly Mechanism
- Added `keepLastOnly?: boolean` to `MessageFilter` interface
- Refactored `applyMessageFilters` into two phases:
  - Phase 1: immediate filters (forward pass, chained)
  - Phase 2: keepLastOnly filters (reverse pass, dedup)
- Shared `applyDecision` helper extracted for DRY

## Phase 3: Builtin Filters
- `omo-todo-continuation`: matches `[SYSTEM DIRECTIVE` + `TODO CONTINUATION`, keepLastOnly
- `omo-context`: matches `[CONTEXT]` or `CONTEXT:` prefix, keepLastOnly
- `omo-task-directive`: matches `TASK:` or `## TASK` prefix, keepLastOnly
- `omo-mode-injection`: matches `[search-mode]`, `[analyze-mode]`, `<ultrawork-mode>`, strip all

## Phase 4: Tests
- 4 new tests: keep-last TODO, keep-last CONTEXT, single occurrence, mode injection strip all
- 927/927 total pass
