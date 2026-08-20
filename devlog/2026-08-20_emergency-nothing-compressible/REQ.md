# REQ — Emergency + Nothing-Compressible Notice (Issue #216 Residual)

## Problem

Incident `ses_7fb5cbc8` (issue #37 discussion): the user's global config set
`minContextLimit`/`maxContextLimit` to 20%, putting the session (55% actual usage)
permanently into emergency mode. `inject.ts` computed:

```typescript
shouldInjectNudge = nudgeAllowed && (!nothingToCompress || emergencyOverride)
```

The `emergencyOverride` bypass made the plugin demand "Context limit reached —
compress now" every turn even when `nothingToCompress` was true (all ranges
protected, in the protected zone, or below the effective floor). With no valid
targets the model retried phantom ranges, each failure re-armed the nudge, and
the session looped ~12 failed compressions (issue #216's loop shape, surviving
the v1.14.4 fix through the emergency path).

User confirmation: "这里是有问题的应该有一个 issue 和这个相关的 你看看" → issue #216.

## Requirements

1. Emergency mode with nothing-to-compress must NOT inject compress instructions.
2. The model must still learn the context is critically full — via a cadence-gated
   notice recommending OpenCode's built-in `/compact`, a new session, or relaxing
   protection settings.
3. Regular nudges (something to compress) keep the emergency bypass unchanged.
4. The notice must not nag every turn — reuse the `lastNudgeShownTokens` growth
   cadence (`growthFloor`).

## Non-Goals

- Changing emergency threshold computation (`resolveEmergencyThreshold`).
- Changing tier-2/3 trigger gating.
