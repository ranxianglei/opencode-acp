# REQ: Fix omo-mode-injection filter dropping user content

## Problem (Issue #262)

The `omo-mode-injection` filter (v1.0.0) matched OMO mode injection patterns at the start of user messages and returned `action: "drop"` — clearing the ENTIRE message. But OMO mode injections are **prepended** to the user's actual message, not standalone.

This meant: when a user sent "Fix the bug" with OMO ultrawork mode active, the message arrived as:

```
<ultrawork-mode>

Mode instructions...

</ultrawork-mode>

Fix the bug
```

The filter matched `<ultrawork-mode>`, dropped the whole message, and the model saw nothing — losing the user's actual request.

## Root Cause

The filter was written assuming mode injections are standalone messages (like `omo-context` and `omo-task-directive`). But mode injections are **prepended** to user content via the `UserPromptSubmit` hook's `additionalContext`.

Confirmed via oh-my-openagent source: `getPlannerUltraworkMessage()` returns `<ultrawork-mode>\n\n...\n</ultrawork-mode>\n\n` — the trailing `\n\n` is where user content follows.

## Secondary Bug: Config Validation

`lib/config-validation.ts` did not skip recursion into `messageFilters.filters` (a dynamic key map keyed by filter name). Users who set `messageFilters.filters.omo-mode-injection.enabled` in their config got a spurious "unknown config key" warning.

## Fix

### Filter (`omo-mode-injection.ts` v1.0.0 → v1.1.0)

Rewrote to strip injection blocks and preserve user content:
- XML tags (`<ultrawork-mode>...</ultrawork-mode>`): find closing tag, strip block, keep remainder
- Bracket patterns (`[search-mode]`): strip marker, keep rest
- Stacked injections (hyperplan wrapping ultrawork): loop up to 5x
- Returns `modify` when user content survives; `drop` only when nothing remains

Pattern matches `omo-system-reminder.ts` (strip + modify), not the pure-injection filters (drop).

### Config Validation (`config-validation.ts`)

Added `messageFilters.filters` to the dynamic-key skip list alongside `compress.modelMaxLimits` / `compress.modelMinLimits`.

### Schema (`dcp.schema.json`)

Added `messageFilters` with `enabled` (boolean) + `filters` (additionalProperties map).
