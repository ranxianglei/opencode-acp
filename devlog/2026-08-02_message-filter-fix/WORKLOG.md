# WORKLOG: Fix omo-mode-injection filter dropping user content

## Investigation

1. Read issue #262 — user reports filter is dropping user messages
2. Read `lib/messages/filter/builtin/omo-mode-injection.ts` (v1.0.0) — confirmed it returns `action: "drop"` on any match
3. Searched oh-my-openagent source via grep_app:
   - `packages/omo-opencode/src/hooks/keyword-detector/ultrawork/planner.ts`: `getPlannerUltraworkMessage()` returns `<ultrawork-mode>\n\n...\n</ultrawork-mode>\n\n`
   - Injection is prepended via `UserPromptSubmit` hook `additionalContext`
   - User's actual message follows AFTER `</ultrawork-mode>`
4. Confirmed: mode injections are NOT standalone — they're prepended to user content

## Implementation

### Filter rewrite (`omo-mode-injection.ts`)

- Extracted `stripLeadingModeInjections()`: loops up to 5x to handle stacked injections
- XML tags: finds closing tag via `indexOf`, strips entire block
- Bracket patterns: strips marker prefix
- Returns remaining text or null (if nothing was stripped)
- Filter returns `modify` with remaining text, or `drop` if empty

### Config validation fix (`config-validation.ts`)

Added `messageFilters.filters` to the `continue` skip list at line 75.

### Schema fix (`dcp.schema.json`)

Added `messageFilters` object with `enabled` boolean + `filters` map.

### Tests (`message-filter.test.ts`)

- Updated existing test "mode injection strips all occurrences" → "strips tag, preserves user content" (asserts user content survives)
- Added 9 new tests in `omo-mode-injection filter (v1.1.0)` describe block:
  - Keeps normal messages, assistant messages
  - Strips ultrawork XML block, bracket patterns
  - Handles stacked hyperplan+ultrawork
  - Drops pure injection with no user content
  - Handles unclosed XML tag
  - Preserves angle brackets that aren't mode tags

## Verification

- `npm run typecheck`: clean
- `npm run test`: 951 tests, 0 failures (was 941 before + 10 new tests)

## Files Changed

- `lib/messages/filter/builtin/omo-mode-injection.ts` — rewritten (v1.0.0 → v1.1.0)
- `lib/config-validation.ts` — added messageFilters.filters to skip list
- `dcp.schema.json` — added messageFilters schema
- `tests/message-filter.test.ts` — updated 1 test + added 9 new tests
- `devlog/2026-08-02_message-filter-fix/REQ.md` — this file
- `devlog/2026-08-02_message-filter-fix/WORKLOG.md` — this file
