# WORKLOG: Bug 20 Suppression Format Fix

## Changes

### `lib/messages/inject/utils.ts`

**Lines 184-186**: Fixed Bug 20 suppression format mismatch.

Before:

```typescript
;(part as any).type === "tool-invocation" && (part as any).toolInvocation?.toolName === "compress"
```

After:

```typescript
part.type === "tool" && part.tool === "compress"
```

The previous format (`tool-invocation` / `toolInvocation.toolName`) does not
exist in the OpenCode SDK message part schema. Every other tool-type check
in the codebase uses `part.type === "tool"` + `part.tool`. The Bug 20
suppression was the sole exception — it never matched, so `overMaxLimit`
was never suppressed after a compress call, causing the nudge to fire
repeatedly and trigger over-compression.

## Verification

- TypeScript: pass
- Tests: all pass
- Build: pass
