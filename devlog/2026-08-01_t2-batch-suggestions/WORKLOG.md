# WORKLOG: Document multi-entry compress format for block-based compression

## Changes

1. `lib/prompts/system.ts`: Added multi-entry format example to MULTI-TIER
   COMPRESSION section. Now shows both single-entry and multi-entry formats
   for block-based compression.

2. `lib/messages/inject/inject.ts`: Added multi-entry format to T2/T3 trigger
   nudge text. The nudge now shows both formats alongside each other so the
   model knows it can use multiple content entries at trigger time.

## Iteration history

- v1: Pre-computed batch boundaries via `buildTierBatches()` — over-engineered
- v2: Conditional multi-entry format in T2/T3 trigger (threshold 15+) — unnecessary hinting
- v3: Just document in system prompt — user pointed out nudge also needs it
- v4 (final): Document both formats in system prompt AND nudge, no threshold hints

## Verification

- typecheck: clean
- tests: 942 pass (no logic changes, prompt-only)
