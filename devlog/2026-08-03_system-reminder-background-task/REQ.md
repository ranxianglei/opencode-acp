# REQ: Keep last 2 OMO system-reminder messages, drop older ones (issue #267)

## Problem

The `omo-system-reminder` filter stripped ALL `<system-reminder>` blocks from messages. This deleted `[BACKGROUND TASK COMPLETED]` notifications, preventing the main session from recovering subagent results.

## Fix (revised approach per user feedback)

User insight: instead of content-based filtering (maintaining a list of "important" markers), use a simple positional rule — keep the 2 most recent system-reminder messages, drop all older ones. This is:
- Content-agnostic (no false positives/negatives)
- Future-proof (new notification types automatically preserved if recent)
- Simple (no regex stripping logic)

### Framework change

Added `keepLast?: number` field to `MessageFilter` interface (default: 1). Phase 2 of `applyMessageFilters` now counts matches and keeps the last N, drops earlier ones.

### Filter change

`omo-system-reminder` v1.0.0 → v1.2.0:
- `keepLastOnly: true, keepLast: 2`
- `filter()` returns `{ action: "drop" }` to identify matches for the keepLast dedup
- Last 2 matching messages survive intact, older ones get emptied
