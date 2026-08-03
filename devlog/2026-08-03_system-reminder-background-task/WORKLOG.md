# WORKLOG: Keep last 2 OMO system-reminder messages

## Iteration 1 (abandoned): Content-based PRESERVE_MARKERS

v1.1.0 — Added `PRESERVE_MARKERS = ["[BACKGROUND TASK COMPLETED]", "[BACKGROUND TASK FAILED]"]`. Filter stripped non-critical blocks but preserved blocks containing markers.

User feedback: "你这个修复还会引入新的问题" — content-based approach requires maintaining a marker list, fragile to future OMO changes.

## Iteration 2 (final): Positional keepLast(2)

v1.2.0 — Completely different approach per user suggestion: "把除了最近两条之外的删除，历史上的都可以删除，最近的都让它显示出来"

### Framework change (`types.ts` + `apply.ts`)

- Added `keepLast?: number` to `MessageFilter` interface (default: 1)
- Phase 2 changed from boolean `foundLast` to counter `kept`:
  - `kept < keepCount` → keep match (no modification)
  - `kept >= keepCount` → drop match (empty text)
- Backward compatible: existing `keepLastOnly: true` filters default to `keepLast: 1`

### Filter rewrite (`omo-system-reminder.ts`)

v1.0.0 (strip all blocks) → v1.2.0 (keepLast=2):
- `keepLastOnly: true, keepLast: 2`
- `filter()` returns `{ action: "drop" }` when matching `<system-reminder>` or OMO marker
- No content parsing, no regex stripping, no marker lists
- Phase 2 keeps last 2 matches intact, drops older ones

### Tests

- 8 tests (was 11 in v1.1.0, was 8 in v1.0.0):
  - Unit: `keepLastOnly`/`keepLast` fields, match/drop for user msgs, keep for assistant/plain
  - Integration: 4 msgs → keeps last 2 + drops oldest + normal msg unaffected
  - Integration: single occurrence → no dedup
  - Integration: exactly 2 → both kept

## Verification

- `npm run typecheck`: clean
- `npm run test`: 952 tests, 0 failures
