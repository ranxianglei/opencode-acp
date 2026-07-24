# REQ: Protect compress tool calls from being compressed

## Problem

When the model issues sequential compressions, each compress tool call (which
carries the summary) lives a few messages after the range it compressed. The
next sequential compress's range typically starts right after the previous one's
end, so the previous compress call falls INSIDE the new range and gets pruned.

This creates a "summary-eating chain": each new compression destroys the
previous compression's summary. Over multiple sequential compressions, all
accumulated summaries vanish, causing catastrophic context loss.

Evidence from `ses_07562b88`: 113 messages compressed to 6 in one call because
all previous compress call anchors (b5–b10) were inside the new range and got
pruned along with their summaries.

## Root Cause

Design gap (not a bug in existing logic). `COMPRESS_DEFAULT_PROTECTED_TOOLS`
was `["skill"]` — the `compress` tool was NOT in the list. The hard-exclusion
mechanism (Bug 39, `filterProtectedToolMessages` in `protected-content.ts`)
checks `part.tool` against the `protectedTools` list, so compress tool calls
were never excluded from compression ranges.

Inconsistency: `DEFAULT_PROTECTED_TOOLS` (commands level, for dedup/purgeErrors)
DID include `"compress"`, but `COMPRESS_DEFAULT_PROTECTED_TOOLS` (compress
level, for range/message compression) did NOT.

## Fix

Add `"compress"` to `COMPRESS_DEFAULT_PROTECTED_TOOLS` in `lib/config.ts`.

```typescript
// Before
const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill"]

// After
const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill", "compress"]
```

This makes `filterProtectedToolMessages` hard-exclude compress tool call
messages from compression ranges (Bug 39 mechanism). The compress call
survives intact in visible context; only the surrounding non-protected
messages are compressed.

## Scope

Emergency fix — one-line config default change. Long-term solution (e.g.,
capping visible compress call count, or GC-level message summary truncation)
deferred to a follow-up.

## Files

- `lib/config.ts` — one-line default change
- `tests/protect-compress-calls.test.ts` — 6 tests covering the hard-exclusion

## Backward Compatibility

Users who set an explicit `compress.protectedTools` array are unaffected (the
default only applies when no override is set). Users who relied on compress
calls being compressible can opt out with `compress.protectedTools: ["skill"]`.
