# REQ: Bug 20 Suppression Format Fix

## Problem

`lib/messages/inject/utils.ts:184-186` (Bug 20 suppression) uses a non-existent
part format to detect compress tool calls:

```typescript
(part as any).type === "tool-invocation" &&
(part as any).toolInvocation?.toolName === "compress"
```

The actual OpenCode SDK message part format is `part.type === "tool"` +
`part.tool === "compress"` (used consistently in 18+ other locations across
the codebase: `query.ts:39`, `hooks.ts:365`, `rebuild.ts:56`,
`protected-content.ts:133`, `subagent-results.ts:72`, etc.).

Because the format never matches, `overMaxLimit` is **never suppressed** after
a compression → the max-limit nudge fires again on the very next transform →
the model is forced into an over-compression feedback loop.

## Fix

Change the format to match the actual SDK part shape:

```typescript
if (part.type === "tool" && part.tool === "compress") {
```

This also removes the `(part as any)` casts — the typed `part` already has
the correct shape.

## Impact

- Fixes over-compression feedback loop where the model is repeatedly nudged
  to compress immediately after a successful compression.
- Independent of PR #138 (GC removal) — this bug exists on master.
