# REQ — Soften Protected Zone (Recent Messages)

## Problem

`checkProtectedRange` hard-rejects any compress call covering protected recent messages (last N messages + last N tokens). The model gets an error and must retry with a different range or `dangerous: true`. This is overly restrictive — the protection should be soft (filter out protected messages, compress the rest), not hard (reject the entire call).

## Changes

1. **`preserveRecentMessages` default 20 → 5**: 20 messages is too many for autonomous sessions.
2. **Convert `checkProtectedRange` hard-reject to `filterProtectedRecentMessages` soft-filter**: Protected messages are filtered out of the compress plan (same pattern as `filterLastUserMessage` and `filterProtectedToolMessages`). The compress call succeeds with the remaining non-protected messages.
3. **`dangerous` parameter becomes a no-op**: No hard-reject to bypass. Stays in schema for backward compat.

## Behavior

- Compress range includes protected messages → protected messages filtered out, non-protected compressed normally
- Compress range is entirely protected → all filtered out → error "All selected messages were filtered out"
- `lastSegmentSoftBlock: false` → no filtering (all protection disabled)
