# REQ: Message Filter — Pluggable Third-Party Injection Cleanup

## Problem

Third-party plugins (OMO = Oh My OpenCode) inject ephemeral metadata as user
messages. Over a session, these accumulate to hundreds of thousands of tokens:

| Type | Count | ~Tokens |
|------|-------|---------|
| `<system-reminder>` | 1,464 | 1.9M |
| `[SYSTEM DIRECTIVE]` | 2,760 | 1.0M |
| `[CONTEXT]` | 212 | 72K |

These messages inflate context usage, trigger premature nudges, and waste
compression on content that was never useful to the model.

## Solution

Pluggable `MessageFilter` interface. Filters run BEFORE `assignMessageRefs` in
the message transform pipeline, stripping/trimming/dropping text parts before
ACP assigns refs or counts context usage.

### Interface

```typescript
interface MessageFilter {
    name: string
    version: string
    description: string
    filter(ctx: MessageFilterContext): FilterResult
}
```

### Built-in: OMO system-reminder cleaner

Default filter (`omo-system-reminder` v1.0.0) strips `<system-reminder>` blocks
and `<!-- OMO_INTERNAL_INITIATOR -->` markers from user messages.

### Config

```jsonc
{
    "messageFilters": {
        "enabled": true,
        "filters": {
            "omo-system-reminder": { "enabled": true }
        }
    }
}
```

## Acceptance Criteria

- [x] Filter interface defined + exported
- [x] Registry with register/get/list/clear
- [x] Pipeline integration in hooks.ts (after stripHallucinations, before assignMessageRefs)
- [x] OMO system-reminder filter implemented + tested
- [x] Config section added (defaults: enabled=true, omo-system-reminder enabled)
- [x] Config validation keys added
- [x] 20 unit tests pass
- [x] Full suite: 915/915 pass
- [x] typecheck + build clean
