# REQ: Protected Label Fix — Only Show Triggering Tools

## Problem

`acp_status` and nudge recommendations display `[PROTECTED: read, grep — not compressible]`
when only `read` is in `compress.protectedTools`. The label lists ALL tool names in a
protected message, not just the ones that triggered protection. This causes:

1. **User confusion**: users think `grep` is also protected when it's not
2. **Inflated protection scope**: tools like `grep`/`bash` that happen to share a message
   with a protected tool appear "protected" in the label

## Root Cause

`buildCompressibleRanges` (`lib/messages/inject/utils.ts:778-788`):
```typescript
const tools = new Set<string>()
for (const part of msg.parts || []) {
    // ...
    const toolName = (part as any)?.tool
    if (toolName) tools.add(toolName)  // ← adds ALL tools, not just protected ones
}
```

## Fix

Only collect tool names that actually trigger protection:
- Match against `protectedTools` via `isToolNameProtected()`
- Match against `protectedFilePatterns` via `isFilePathProtected(getFilePathsFromParameters(...))`

## Acceptance Criteria

- [x] `[PROTECTED: ...]` label only shows tools that triggered protection
- [x] Non-protected tools in the same message (e.g., `grep` alongside `read`) not listed
- [x] All existing tests pass
- [x] New test covers the mixed-tools scenario
