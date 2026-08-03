# REQ: Fix omo-system-reminder filter dropping user content

## Problem
The `omo-system-reminder` filter (v1.2.0, PR #268) returns `{ action: "drop" }` for ANY user message containing `<system-reminder>` blocks. Phase 2 `keepLastOnly` then hard-drops older matches entirely — including the user's actual text.

When OMO injects `<system-reminder>` blocks into user messages via `additionalContext`, the user's text and the OMO block share the same message part. Dropping the part loses both.

## Fix
Two changes:

1. **Filter (`omo-system-reminder.ts` v1.3.0)**: Strip `<system-reminder>` blocks and OMO markers. Return `modify` when user content remains after stripping. Return `drop` only when the message is pure OMO content (no user text).

2. **Phase 2 (`apply.ts`)**: For older matches (beyond last N), apply the filter's actual decision (`modify` or `drop`) instead of unconditional `{ action: "drop" }`. This preserves user text in older messages while still stripping stale OMO blocks.
